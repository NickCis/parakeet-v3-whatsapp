/**
 * Runs in the page context (same window as web.whatsapp.com).
 * Injected via chrome.scripting.executeScript with world: 'MAIN'.
 * MutationObserver for audio-play spans, finds data-id parent, adds Transcribe button.
 */
(function () {
  const PageContextLogPrefix = '[Parakeet-WA page-context]';
  if (window.__PARAKEET_PAGE_SCRIPT_LOADED) return;
  window.__PARAKEET_PAGE_SCRIPT_LOADED = true;

  const EventRequestTranscribe = 'parakeet-request-transcribe';
  const EventTranscriptResult = 'parakeet-transcript-result';
  const DataAttrTranscribeAttached = 'data-parakeet-transcribe-attached';
  const AudioPlaySelector = 'span[data-icon="audio-play"]';
  const DataIdAttr = 'data-id';

  let requestIdCounter = 0;
  const pendingByRequestId = {};

  function findParentWithDataId(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute(DataIdAttr)) return node;
      node = node.parentNode;
    }
    return null;
  }

  /**
   * Returns { arrayBuffer, mimetype } for the message audio.
   * https://github.com/pedroslopez/whatsapp-web.js/blob/9b1eb76b2ba0fd26e1d8f46e0bf8ca52bea2506c/src/structures/Message.js#L445
   */
  async function getAudioBlobForId(id) {
    console.log(PageContextLogPrefix, 'getAudioBlobForId', id);
    const msg =
      window.Store.Msg.get(id) ||
      (await window.Store.Msg.getMessagesById([id]))?.messages?.[0];
    if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') {
      console.log(
        PageContextLogPrefix,
        'no msg, media data or reuploading',
        msg?.mediaData?.mediaStage,
      );
      throw new Error('No msg, mediaData or REUPLOADING');
    }

    if (
      msg.mediaData.mediaStage.includes('ERROR') ||
      msg.mediaData.mediaStage === 'FETCHING'
    ) {
      console.log(
        PageContextLogPrefix,
        'error or fetching',
        msg.mediaData.mediaStage,
      );
      throw new Error('ERROR');
    }

    if (msg.mediaData.mediaStage !== 'RESOLVED') {
      await msg.downloadMedia({
        downloadEvenIfExpensive: true,
        rmrReason: 1,
      });
    }

    try {
      const mockQpl = {
        addAnnotations: function () {
          return this;
        },
        addPoint: function () {
          return this;
        },
      };
      const decryptedMedia =
        await window.Store.DownloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath,
          encFilehash: msg.encFilehash,
          filehash: msg.filehash,
          mediaKey: msg.mediaKey,
          mediaKeyTimestamp: msg.mediaKeyTimestamp,
          type: msg.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        });

      console.log(PageContextLogPrefix, 'decryptedMedia', decryptedMedia);

      let arrayBuffer;
      let mimetype = msg.mimetype || msg.mediaData?.mimetype || '';
      if (decryptedMedia instanceof Blob) {
        mimetype = mimetype || decryptedMedia.type || 'audio/ogg';
        arrayBuffer = await decryptedMedia.arrayBuffer();
      } else if (decryptedMedia instanceof ArrayBuffer) {
        arrayBuffer = decryptedMedia;
      } else if (decryptedMedia && typeof decryptedMedia.arrayBuffer === 'function') {
        arrayBuffer = await decryptedMedia.arrayBuffer();
      } else {
        throw new Error('Unsupported decryptedMedia type');
      }
      return { arrayBuffer, mimetype };
    } catch (e) {
      if (e.status && e.status === 404) return undefined;
      throw e;
    }
  }

  function extensionFromMimetype(mimetype) {
    if (!mimetype) return 'ogg';
    const map = { 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'weba' };
    return map[mimetype] || mimetype.split('/')[1] || 'ogg';
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function triggerDownload(arrayBuffer, mimetype, dataId) {
    const ext = extensionFromMimetype(mimetype);
    const blob = new Blob([arrayBuffer], { type: mimetype || 'audio/ogg' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'whatsapp-audio-' + (dataId || Date.now()) + '.' + ext;
    a.click();
    URL.revokeObjectURL(url);
  }

  function injectStore() {
    if (typeof window.require === 'undefined') {
      setTimeout(injectStore, 500);
      return;
    }
    try {
      window.Store = Object.assign({}, window.require('WAWebCollections'));
      window.Store.DownloadManager = window.require(
        'WAWebDownloadManager',
      ).downloadManager;
    } catch (e) {
      setTimeout(injectStore, 500);
    }
  }
  injectStore();

  function getLoadingImgSrc() {
    return window.__PARAKEET_LOADING_URL || '';
  }

  function attachButtonToContainer(container) {
    if (container.hasAttribute(DataAttrTranscribeAttached)) return;
    container.setAttribute(DataAttrTranscribeAttached, 'true');

    const dataId = container.getAttribute(DataIdAttr);

    const resultEl = document.createElement('p');
    resultEl.className = 'parakeet-wa-transcribe-result';

    const imgLoading = document.createElement('img');
    imgLoading.className = 'parakeet-wa-transcribe-loading';
    imgLoading.style.display = 'none';
    imgLoading.width = 24;
    imgLoading.height = 24;
    imgLoading.alt = '';
    const loadingSrc = getLoadingImgSrc();
    if (loadingSrc) imgLoading.src = loadingSrc;

    const btn = document.createElement('button');
    btn.className = 'parakeet-wa-transcribe-btn';
    btn.textContent = 'Transcribe';

    btn.onclick = async function () {
      btn.style.display = 'none';
      imgLoading.style.display = 'inline';
      resultEl.textContent = 'Transcribing…';

      const requestId = ++requestIdCounter;
      pendingByRequestId[requestId] = { resultEl, btn, imgLoading };

      try {
        const { arrayBuffer, mimetype } = await getAudioBlobForId(dataId);
        console.log(PageContextLogPrefix, 'msg.mimetype / mimetype', mimetype);
        console.log(PageContextLogPrefix, 'dispatching transcribe', 'requestId=', requestId, 'arrayBuffer.byteLength=', arrayBuffer?.byteLength);
        // triggerDownload(arrayBuffer, mimetype, dataId);
        const audioBase64 = arrayBufferToBase64(arrayBuffer);
        document.dispatchEvent(
          new CustomEvent(EventRequestTranscribe, {
            detail: { requestId, audioBase64 },
          }),
        );
      } catch (err) {
        resultEl.textContent = (err && err.message) || 'Failed to get audio.';
        btn.style.display = 'block';
        imgLoading.style.display = 'none';
        delete pendingByRequestId[requestId];
      }
    };

    container.appendChild(btn);
    container.appendChild(imgLoading);
    container.appendChild(resultEl);
  }

  const observer = new MutationObserver(function (mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const spans = node.querySelectorAll
          ? node.querySelectorAll(AudioPlaySelector)
          : [];
        for (const span of spans) {
          const container = findParentWithDataId(span);
          if (!container) continue;
          attachButtonToContainer(container);
        }
      }
    }
  });

  document.addEventListener(EventTranscriptResult, function (ev) {
    const { requestId, transcript, error } = ev.detail || {};
    const pending = pendingByRequestId[requestId];
    if (!pending) return;
    delete pendingByRequestId[requestId];
    pending.resultEl.textContent = error != null ? error : transcript || '';
    pending.btn.style.display = 'block';
    pending.imgLoading.style.display = 'none';
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
})();
