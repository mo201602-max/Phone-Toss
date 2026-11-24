import { createCamera } from './camera.js?v=10fps';

export const gravity = 9.80665;

function crossing(previous, current, threshold) {
  const fraction = (threshold - previous.value) / (current.value - previous.value);
  return previous.time + fraction * (current.time - previous.time);
}

export function createDetector() {
  const releaseThreshold = 2.5;
  const contactThreshold = 6;
  let previous;
  let release;
  let lowSamples = 0;
  let contact;
  let lastThrust = -Infinity;
  return function sample(time, value) {
    const current = { time, value };
    const prior = previous;
    previous = current;
    if (!prior || time - prior.time > 100) {
      release = contact = undefined;
      lowSamples = 0;
      lastThrust = -Infinity;
    }
    if (value >= 12) lastThrust = time;
    if (release === undefined) {
      if (prior && time - prior.time <= 100 && prior.value > releaseThreshold &&
          value <= releaseThreshold && time - lastThrust <= 450) {
        release = crossing(prior, current, releaseThreshold);
        lowSamples = 1;
      }
      return { phase: 'ready' };
    }
    if (value <= releaseThreshold) {
      lowSamples++;
      contact = undefined;
    }
    if (value >= contactThreshold && contact === undefined) {
      contact = prior.value < contactThreshold ? crossing(prior, current, contactThreshold) : time;
    }
    const elapsed = (contact ?? time) - release;
    if (elapsed > 2500 || (contact !== undefined && (elapsed < 90 || lowSamples < 2))) {
      release = contact = undefined;
      lowSamples = 0;
      return { phase: 'ready' };
    }
    if (contact !== undefined && value >= contactThreshold && (value >= 15 || time - contact >= 25)) {
      const seconds = elapsed / 1000;
      const catchTime = contact;
      release = contact = undefined;
      lowSamples = 0;
      return { phase: 'result', seconds, catchTime, centimeters: 100 * gravity * seconds ** 2 / 8 };
    }
    return { phase: lowSamples >= 2 && elapsed >= 45 ? 'flight' : 'ready' };
  };
}

const element = id => document.getElementById(id);
const start = element('start');
const status = element('status');
const camera = element('shots') ? createCamera(element) : null;
let mode = 'idle';
let detector;
let timer;
let hasSamples;
let lastPhase;
const historyKey = camera ? 'phone-toss-camera-history' : 'phone-toss-history';
const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

function topTwenty(items) {
  return items.sort((a, b) => b.centimeters - a.centimeters || Date.parse(b.date) - Date.parse(a.date)).slice(0, 20);
}

function readHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(historyKey) ?? '[]');
    return Array.isArray(saved) ? topTwenty(saved.filter(record =>
      record && Number.isFinite(record.centimeters) && Number.isFinite(record.seconds) &&
      typeof record.date === 'string' && Number.isFinite(Date.parse(record.date))
    )) : [];
  } catch {
    return [];
  }
}

let records = readHistory();

function renderHistory() {
  element('history-empty').hidden = records.length > 0;
  const list = element('history');
  list.replaceChildren();
  for (const record of records) {
    const row = document.createElement('li');
    const measurement = document.createElement('strong');
    const date = document.createElement('time');
    measurement.textContent = record.centimeters.toFixed(1) + ' cm / ' + record.seconds.toFixed(3) + ' 秒';
    date.dateTime = record.date;
    date.textContent = dateFormat.format(new Date(record.date));
    row.append(measurement, date);
    list.append(row);
  }
}

function saveResult({ centimeters, seconds }) {
  const entry = { centimeters, seconds, date: new Date().toISOString() };
  const updated = topTwenty([entry, ...readHistory()]);
  try {
    localStorage.setItem(historyKey, JSON.stringify(updated));
  } catch {
    return false;
  }
  records = updated;
  renderHistory();
  return updated.includes(entry) ? "saved" : "outside";
}

renderHistory();
window.addEventListener('storage', event => {
  if (event.key === historyKey || event.key === null) {
    records = readHistory();
    renderHistory();
  }
});

function stop(message) {
  window.removeEventListener('devicemotion', onMotion);
  clearTimeout(timer);
  camera?.stop();
  mode = 'idle';
  start.disabled = false;
  start.textContent = camera ? 'カメラと計測を開始' : '計測を開始';
  status.textContent = message;
}

function prepare() {
  mode = 'sensor';
  detector = createDetector();
  lastPhase = '';
  element('height').textContent = '—';
  element('duration').textContent = '— 秒';
  element('accel').textContent = '— m/s²';
}

function feed(time, magnitude) {
  element('accel').textContent = magnitude.toFixed(1) + ' m/s²';
  const result = detector(time, magnitude);
  if (result.phase === 'result') {
    element('height').textContent = result.centimeters.toFixed(1);
    element('duration').textContent = result.seconds.toFixed(3) + ' 秒';
    const saved = saveResult(result);
    const message = saved === 'saved' ? 'ベスト20に記録しました。' :
      saved === 'outside' ? '計測完了。今回はベスト20圏外です。' : '計測完了。ランキングを保存できませんでした。';
    if (camera) {
      window.removeEventListener('devicemotion', onMotion);
      clearTimeout(timer);
      mode = 'finishing';
      start.textContent = '撮影を停止';
      status.textContent = 'キャッチを検知しました。撮影中…';
      camera.finish(result).then(count => {
        if (mode !== 'finishing') return;
        stop(message + (count ? ' コマを選べます。' : ' 撮影できたコマがありません。'));
        start.textContent = 'もう一度計測';
      });
    } else {
      stop(message);
      start.textContent = 'もう一度計測';
    }
  } else if (result.phase !== lastPhase) {
    lastPhase = result.phase;
    status.textContent = result.phase === 'flight' ? '滞空中…' :
      '計測待機中。端末を手に持ち、軽く放り上げてください。';
  }
}

function onMotion(event) {
  const vector = event.accelerationIncludingGravity;
  if (!vector || ![vector.x, vector.y, vector.z].every(Number.isFinite)) return;
  if (!hasSamples) {
    hasSamples = true;
    clearTimeout(timer);
    timer = setTimeout(() => stop('計測時間が終了しました。再度お試しください。'), 30000);
  }
  feed(event.timeStamp, Math.hypot(vector.x, vector.y, vector.z));
}

start.addEventListener('click', async () => {
  if (mode === 'sensor' || mode === 'finishing') {
    stop('計測を停止しました。');
    return;
  }
  if (!window.isSecureContext || !window.DeviceMotionEvent) {
    stop('センサーに対応したスマホのブラウザで HTTPS のページを開いてください。');
    return;
  }
  start.disabled = true;
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function' &&
        await DeviceMotionEvent.requestPermission() !== 'granted') {
      stop('モーションセンサーが許可されていません。ブラウザの設定をご確認ください。');
      return;
    }
  } catch {
    stop('モーションセンサーの許可を取得できませんでした。');
    return;
  }
  if (camera) {
    status.textContent = '前面カメラを準備中…';
    try {
      await camera.start();
    } catch {
      stop('前面カメラを開始できませんでした。ブラウザのカメラ許可をご確認ください。');
      return;
    }
    if (document.hidden) {
      stop('画面を離れたため、計測を停止しました。');
      return;
    }
  }
  prepare();
  hasSamples = false;
  start.disabled = false;
  start.textContent = '計測を停止';
  status.textContent = 'センサーを確認中…';
  window.addEventListener('devicemotion', onMotion);
  timer = setTimeout(() => stop(
    'センサーのデータを受信できませんでした。スマホのブラウザ設定をご確認ください。'
  ), 4000);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && (mode === 'sensor' || mode === 'finishing')) stop('画面を離れたため、計測を停止しました。');
});
