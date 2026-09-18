function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择文件'));
    reader.onabort = () => reject(new Error('文件读取已取消'));
    reader.readAsDataURL(file);
  });
}

export async function uploadFile(file) {
  if (!(file instanceof Blob) || !file.size) throw new Error('请选择有效的媒体文件');
  const data = await readBase64(file);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch('/api/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name || `image-${Date.now()}.png`, type: file.type || 'application/octet-stream', data }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || result?.message || `媒体上传失败（${response.status}）`);
    if (!result?.media) throw new Error('服务器未返回媒体信息，请重新上传');
    return result.media;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('媒体上传超时，请检查连接后重试');
    if (error instanceof TypeError) throw new Error('无法连接媒体服务，请确认服务正在运行');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractVideoCover(file) {
  return new Promise((resolve, reject) => {
    if (!(file instanceof Blob) || !file.size) { reject(new Error('请选择有效的视频文件')); return; }
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    let seeking = false;
    let duration = 0;
    const timeout = setTimeout(() => finish(new Error('视频读取超时，请换用浏览器支持的 MP4 视频')), 20000);

    function cleanup() {
      clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('seeked', capture);
      video.removeEventListener('error', failed);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(result);
    }

    function failed() {
      finish(new Error('无法解码此视频，请使用浏览器支持的 MP4（H.264）视频'));
    }

    function metadata() {
      duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) { finish(new Error('无法获取有效的视频时长')); return; }
      if (!video.videoWidth || !video.videoHeight) { finish(new Error('视频中没有可读取的画面')); return; }
    }

    function loaded() {
      if (settled || seeking) return;
      if (!Number.isFinite(duration) || duration <= 0) { metadata(); if (settled) return; }
      seeking = true;
      const target = Math.min(0.15, duration / 4);
      if (target > 0) video.currentTime = target; else capture();
    }

    function capture() {
      if (settled) return;
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1280 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('浏览器无法创建视频封面');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          if (!blob) { finish(new Error('视频封面生成失败，请重新选择视频')); return; }
          const basename = (file.name || 'video').replace(/\.[^.]+$/, '');
          finish(null, { file: new File([blob], `${basename}-cover.jpg`, { type: 'image/jpeg' }), duration });
        }, 'image/jpeg', 0.9);
      } catch (error) {
        finish(new Error(`视频封面生成失败：${error.message}`));
      }
    }

    video.addEventListener('loadedmetadata', metadata);
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('seeked', capture);
    video.addEventListener('error', failed);
    video.src = url;
    video.load();
  });
}

