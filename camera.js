const FRAME_INTERVAL = 100;
const BUFFER_WINDOW = 3000;
const AFTER_CATCH = 1000;

export async function chooseIndoorExposure(track, checkPicture) {
  const capabilities = track.getCapabilities?.();
  const range = capabilities?.exposureTime;
  if (!capabilities?.exposureMode?.includes('manual') || !Number.isFinite(range?.min) ||
      !Number.isFinite(range?.max) || typeof track.applyConstraints !== 'function') return 'unsupported';

  const automatic = track.getSettings?.().exposureTime;
  const limit = automatic > range.min ? Math.min(range.max, automatic) : range.max;
  const min = range.min;
  const step = range.step > 0 ? range.step : 0;
  const candidates = new Set([min]);
  for (let i = 1; i <= 7; i++) {
    const value = Math.expm1(Math.log1p(limit - min) * i / 7) + min;
    candidates.add(Math.min(limit, step ? min + Math.floor((value - min) / step + 1e-8) * step : value));
  }

  for (const exposureTime of candidates) {
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime }] });
    } catch {
      return 'fallback';
    }
    const actual = track.getSettings?.();
    if (actual?.exposureMode !== 'manual' || !Number.isFinite(actual.exposureTime) ||
        Math.abs(actual.exposureTime - exposureTime) > Math.max(step / 2, exposureTime * 0.01, 1e-9)) {
      return 'fallback';
    }
    if (await checkPicture() === 'visible') return 'applied';
  }
  return 'fallback';
}

export function createCamera(element) {
  const panel = element('shots');
  const photo = element('photo');
  const slider = element('frame');
  const share = element('share');
  const video = element('camera-preview');
  const sample = document.createElement('canvas');
  sample.width = sample.height = 24;
  const sampleContext = sample.getContext('2d', { willReadFrequently: true });
  video.muted = video.playsInline = true;
  let stream;
  let interval;
  let timer;
  let resolveFinish;
  let buffer = [];
  let frames = [];
  let result;

  function stop() {
    clearInterval(interval);
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    video.srcObject = null;
    video.hidden = true;
    buffer = [];
    resolveFinish?.(0);
    resolveFinish = undefined;
  }

  function capture() {
    if (video.readyState < 2 || !video.videoWidth) return;
    const time = performance.now();
    const frame = document.createElement('canvas');
    const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
    frame.width = Math.round(video.videoWidth * scale);
    frame.height = Math.round(video.videoHeight * scale);
    const ctx = frame.getContext('2d');
    ctx.translate(frame.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, frame.width, frame.height);
    buffer.push({ time, frame });
    buffer = buffer.filter(item => time - item.time <= BUFFER_WINDOW);
  }

  async function openCamera() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 30 }
      }
    });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
  }

  async function checkPicture() {
    let picture = 'missing';
    let brightSamples = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (video.readyState < 2 || !video.videoWidth) continue;
      const x = video.videoWidth / 4;
      const y = video.videoHeight / 4;
      sampleContext.drawImage(video, x, y, x * 2, y * 2, 0, 0, 24, 24);
      const pixels = sampleContext.getImageData(0, 0, 24, 24).data;
      let lit = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] >= 32) lit++;
      }
      picture = 'dark';
      brightSamples = lit >= 231 && attempt > 0 ? brightSamples + 1 : 0;
      if (brightSamples === 2) return 'visible';
    }
    return picture;
  }

  async function start() {
    await openCamera();
    const exposure = await chooseIndoorExposure(stream.getVideoTracks()[0], checkPicture);
    let picture = 'visible';
    let settingsMessage;
    if (exposure === 'applied') {
      settingsMessage = '中央が写る範囲で短い露光時間を選びました。';
    } else if (exposure === 'unsupported') {
      picture = await checkPicture();
      settingsMessage = '前面カメラは自動露光です。';
    } else {
      // A driver can apply manual exposure while omitting it from getSettings().
      // Open a fresh stream to discard the manual constraints.
      stop();
      await openCamera();
      picture = await checkPicture();
      settingsMessage = '手動露光で中央の明るさを確保できなかったか、設定を確認できなかったため、自動露光に戻しました。';
    }
    if (picture === 'missing') {
      element('camera-settings').textContent = settingsMessage + ' カメラ映像を取得できませんでした。';
      throw new Error('No camera frames');
    }
    if (picture === 'dark') {
      settingsMessage += ' プレビューがほぼ真っ黒です。明るい場所でもう一度お試しください。';
    }
    element('camera-settings').textContent = '最大10 fps。' + settingsMessage;
    panel.hidden = true;
    frames = [];
    capture();
    interval = setInterval(capture, FRAME_INTERVAL);
  }

  function draw() {
    const index = Number(slider.value);
    const { frame } = frames[index];
    photo.width = frame.width * 2;
    photo.height = frame.height * 2 + 104;
    const ctx = photo.getContext('2d');
    const bar = photo.height - 104;
    ctx.drawImage(frame, 0, 0, photo.width, bar);
    ctx.fillStyle = '#ffdf38';
    ctx.fillRect(0, bar, photo.width, 104);
    ctx.fillStyle = '#ff66a9';
    ctx.fillRect(0, bar, photo.width, 7);
    ctx.fillStyle = '#142544';
    ctx.textAlign = 'center';
    ctx.font = '900 25px "Dela Gothic One", system-ui, sans-serif';
    ctx.fillText('スマッホをほおーりゃ', photo.width / 2, bar + 41, photo.width - 20);
    ctx.font = '900 29px "Dela Gothic One", system-ui, sans-serif';
    ctx.fillText(`${result.centimeters.toFixed(1)} cm / ${result.seconds.toFixed(3)} 秒`, photo.width / 2, bar + 82, photo.width - 20);
    element('frame-number').textContent = `${index + 1} / ${frames.length}`;
  }

  function finish(measurement) {
    result = measurement;
    const end = result.catchTime + AFTER_CATCH;
    const apex = result.catchTime - result.seconds * 500;
    return new Promise(resolve => {
      resolveFinish = resolve;
      timer = setTimeout(() => {
        frames = buffer.filter(item => item.time >= apex && item.time <= end);
        resolveFinish = undefined;
        stop();
        if (frames.length) {
          slider.max = String(frames.length - 1);
          slider.value = '0';
          slider.disabled = frames.length === 1;
          element('photo-status').textContent = '';
          draw();
          document.fonts?.ready.then(() => { if (frames.length && !panel.hidden) draw(); });
          panel.hidden = false;
        }
        resolve(frames.length);
      }, Math.max(0, end - performance.now()));
    });
  }

  function photoFile() {
    const data = atob(photo.toDataURL('image/jpeg', 0.8).split(',')[1]);
    return new File([Uint8Array.from(data, char => char.charCodeAt(0))],
      'phone-toss.jpg', { type: 'image/jpeg' });
  }

  slider.addEventListener('input', draw);
  element('download').addEventListener('click', () => {
    const url = URL.createObjectURL(photoFile());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'phone-toss.jpg';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  share.hidden = !navigator.share || !navigator.canShare;
  share.addEventListener('click', async () => {
    const files = [photoFile()];
    const feedback = element('photo-status');
    if (!navigator.canShare({ files })) {
      feedback.textContent = 'このブラウザでは写真を直接共有できません。「写真を保存」を使ってください。';
      return;
    }
    try {
      await navigator.share({ files });
      feedback.textContent = '';
    } catch (error) {
      if (error.name !== 'AbortError') feedback.textContent = '共有できませんでした。「写真を保存」を使ってください。';
    }
  });

  return { start, stop, finish };
}
