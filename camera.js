const FRAME_INTERVAL = 100;
const BUFFER_WINDOW = 3000;
const AFTER_CATCH = 1000;

export async function setShortestExposure(track) {
  const capabilities = track.getCapabilities?.();
  const minimum = capabilities?.exposureTime?.min;
  if (!capabilities?.exposureMode?.includes('manual') || !Number.isFinite(minimum) ||
      typeof track.applyConstraints !== 'function') return 'unsupported';

  try {
    await track.applyConstraints({
      advanced: [{ exposureMode: 'manual', exposureTime: minimum }]
    });
    const settings = track.getSettings?.();
    return settings?.exposureMode === 'manual' && settings.exposureTime === minimum
      ? 'applied' : 'unconfirmed';
  } catch {
    return 'unconfirmed';
  }
}

export function createCamera(element) {
  const panel = element('shots');
  const photo = element('photo');
  const slider = element('frame');
  const share = element('share');
  const video = document.createElement('video');
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

  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 30 }
      }
    });
    const exposure = await setShortestExposure(stream.getVideoTracks()[0]);
    element('camera-settings').textContent = {
      applied: '撮影は最大10 fps。前面カメラの最短露光を適用しました。',
      unsupported: '撮影は最大10 fps。このブラウザでは前面カメラの露光時間を手動調整できません。',
      unconfirmed: '撮影は最大10 fps。前面カメラの最短露光を確認できませんでした。'
    }[exposure];
    video.srcObject = stream;
    await video.play();
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
