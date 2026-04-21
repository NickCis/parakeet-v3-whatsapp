/**
 * Runs in the page context (same window as web.whatsapp.com).
 * Injected via script tag by the content script. Reads loading GIF URL from script src query param.
 * MutationObserver for audio-play spans, finds data-id parent, adds Transcribe button.
 */
(async function () {
  if (window.__PARAKEET_PAGE_SCRIPT_LOADED) return;
  window.__PARAKEET_PAGE_SCRIPT_LOADED = true;
  const LogPrefix = '[Parakeet-WA main]';

  function log(...args) {
    console.log(LogPrefix, ...args);
  }

  function error(...args) {
    console.error(LogPrefix, ...args);
  }

  function warn(...args) {
    console.warn(LogPrefix, ...args);
  }

  try {
    const ParakeetMessageTopic = 'parakeet-message';
    const DataAttrTranscribeAttached = 'data-parakeet-transcribe-attached';
    const AudioPlaySelector = 'div[role="slider"],div[aria-valuemin="0"]';
    const DataIdAttr = 'data-id';

    function sendMessage(type, payload) {
      document.dispatchEvent(
        new CustomEvent(ParakeetMessageTopic, {
          detail: { ...payload, type, origin: 'main' },
        }),
      );
    }

    const PendingByRequestId = {};
    const CompletedByRequestId = {};
    function findParentWithDataId(el) {
      let node = el;
      while (node && node !== document.body) {
        if (node.getAttribute && node.getAttribute(DataIdAttr)) return node;
        node = node.parentNode;
      }
      return null;
    }

    const i18nMessages = {};
    async function i18nGetMessages(keys) {
      const filteredKeys = keys.filter(k => !i18nMessages[k]);
      for (const k of filteredKeys) {
        i18nMessages[k] = {};
        i18nMessages[k].promise = new Promise((rs, rj) => {
          i18nMessages[k].rs = rs;
          i18nMessages[k].rj = rj;
        });
      }
      sendMessage('i18n.getMessage', { keys: filteredKeys });

      const msgs = await Promise.all(keys.map(k => i18nMessages[k].promise));
      return msgs.reduce((acc, msg) => {
        acc[msg.key] = msg.message;
        return acc;
      }, {});
    }

    /**
     * DOM `data-id` may not equal `Store.Msg` keys anymore; find the first
     * `_index` key that contains the attribute value (your working approach).
     */
    function resolveStoreMessageIdFromDomDataId(dataId) {
      if (dataId == null || dataId === '') return dataId;
      const idx = window.Store?.Msg?._index;
      if (!idx || typeof idx !== 'object') return dataId;
      const hit = Object.keys(idx).filter(n => n.includes(dataId))[0];
      return hit || dataId;
    }

    /**
     * Returns { arrayBuffer, mimetype } for the message audio.
     * https://github.com/pedroslopez/whatsapp-web.js/blob/9b1eb76b2ba0fd26e1d8f46e0bf8ca52bea2506c/src/structures/Message.js#L445
     */
    async function getAudioBlobForId(id) {
      const storeId = resolveStoreMessageIdFromDomDataId(id);
      const msg =
        window.Store.Msg.get(storeId) ||
        (await window.Store.Msg.getMessagesById([storeId]))?.messages?.[0];
      if (
        !msg ||
        !msg.mediaData ||
        msg.mediaData.mediaStage === 'REUPLOADING'
      ) {
        warn('no msg, media data or reuploading', msg?.mediaData?.mediaStage);
        throw new Error('No msg, mediaData or REUPLOADING');
      }

      if (
        msg.mediaData.mediaStage.includes('ERROR') ||
        msg.mediaData.mediaStage === 'FETCHING'
      ) {
        warn('error or fetching', msg.mediaData.mediaStage);
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

        let arrayBuffer;
        let mimetype = msg.mimetype || msg.mediaData?.mimetype || '';
        if (decryptedMedia instanceof Blob) {
          mimetype = mimetype || decryptedMedia.type || 'audio/ogg';
          arrayBuffer = await decryptedMedia.arrayBuffer();
        } else if (decryptedMedia instanceof ArrayBuffer) {
          arrayBuffer = decryptedMedia;
        } else if (
          decryptedMedia &&
          typeof decryptedMedia.arrayBuffer === 'function'
        ) {
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

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    /**
    https://github.com/pedroslopez/whatsapp-web.js/blob/main/src/util/Injected/Store.js
    */
    function injectStore() {
      if (typeof window.require === 'undefined') {
        setTimeout(injectStore, 100);
        return;
      }

      try {
        window.Store = Object.assign({}, window.require('WAWebCollections'));
        window.Store.DownloadManager = window.require(
          'WAWebDownloadManager',
        ).downloadManager;
      } catch (e) {
        setTimeout(injectStore, 100);
      }
    }

    injectStore();

    function attachButtonToContainer(container) {
      if (container.hasAttribute(DataAttrTranscribeAttached)) return;
      container.setAttribute(DataAttrTranscribeAttached, 'true');
      const dataId = container.getAttribute(DataIdAttr);

      const parakeetContainer = document.createElement('div');
      parakeetContainer.className = 'parakeet-wa-transcribe-container';

      const btn = document.createElement('button');
      btn.className = 'parakeet-wa-transcribe-btn';
      btn.textContent = I18N['transcribe'];

      const resultContainer = document.createElement('div');
      resultContainer.className = 'parakeet-wa-transcribe-result';
      resultContainer.style.display = 'none';
      resultContainer.innerHTML = `<span></span><svg class="parakeet-wa-transcribe-result-svg" viewBox="0 0 19 26" height="26" width="19" preserveAspectRatio="xMidYMid meet" version="1.1" x="0px" y="0px" enable-background="new 0 0 19 26"><title>ptt-status</title><path fill="#FFFFFF" class="parakeet-wa-transcribe-result-svg-bg" d="M9.217,24.401c-1.158,0-2.1-0.941-2.1-2.1v-2.366c-2.646-0.848-4.652-3.146-5.061-5.958L2.004,13.62 l-0.003-0.081c-0.021-0.559,0.182-1.088,0.571-1.492c0.39-0.404,0.939-0.637,1.507-0.637h0.3c0.254,0,0.498,0.044,0.724,0.125v-6.27 C5.103,2.913,7.016,1,9.367,1c2.352,0,4.265,1.913,4.265,4.265v6.271c0.226-0.081,0.469-0.125,0.723-0.125h0.3 c0.564,0,1.112,0.233,1.501,0.64s0.597,0.963,0.571,1.526c0,0.005,0.001,0.124-0.08,0.6c-0.47,2.703-2.459,4.917-5.029,5.748v2.378 c0,1.158-0.942,2.1-2.1,2.1H9.217V24.401z"></path><path fill="currentColor" class="parakeet-wa-transcribe-result-svg-icon" d="M9.367,15.668c1.527,0,2.765-1.238,2.765-2.765V5.265c0-1.527-1.238-2.765-2.765-2.765 S6.603,3.738,6.603,5.265v7.638C6.603,14.43,7.84,15.668,9.367,15.668z M14.655,12.91h-0.3c-0.33,0-0.614,0.269-0.631,0.598 c0,0,0,0-0.059,0.285c-0.41,1.997-2.182,3.505-4.298,3.505c-2.126,0-3.904-1.521-4.304-3.531C5.008,13.49,5.008,13.49,5.008,13.49 c-0.016-0.319-0.299-0.579-0.629-0.579h-0.3c-0.33,0-0.591,0.258-0.579,0.573c0,0,0,0,0.04,0.278 c0.378,2.599,2.464,4.643,5.076,4.978v3.562c0,0.33,0.27,0.6,0.6,0.6h0.3c0.33,0,0.6-0.27,0.6-0.6V18.73 c2.557-0.33,4.613-2.286,5.051-4.809c0.057-0.328,0.061-0.411,0.061-0.411C15.243,13.18,14.985,12.91,14.655,12.91z"></path></svg>`;
      const resultEl = resultContainer.querySelector('span');
      const divLoading = document.createElement('div');
      divLoading.className = 'parakeet-wa-loading-container';
      divLoading.innerHTML = `<div><svg class="parakeet-wa-loading" width="12" height="12" viewBox="0 0 46 46"><circle class="parakeet-wa-loading-circle" cx="23" cy="23" r="20" fill="none" stroke-width="6"></circle></svg></div><span class="parakeet-wa-loading-message">${I18N['transcribing']}</span>`;
      divLoading.style.display = 'none';

      btn.addEventListener('click', async () => {
        if (CompletedByRequestId[dataId]) {
          btn.style.display = 'none';
          resultEl.textContent = CompletedByRequestId[dataId];
          resultContainer.style.display = null;
          return;
        }

        btn.style.display = 'none';
        divLoading.style.display = null;

        PendingByRequestId[dataId] = (err, transcript) => {
          resultEl.textContent = err != null ? err : transcript || '';
          resultContainer.style.display = null;
          divLoading.style.display = 'none';
        };

        try {
          const { arrayBuffer, mimetype } = await getAudioBlobForId(dataId);
          log('msg.mimetype / mimetype', mimetype);
          log(
            'dispatching transcribe',
            'dataId=',
            dataId,
            'arrayBuffer.byteLength=',
            arrayBuffer?.byteLength,
          );
          const audioBase64 = arrayBufferToBase64(arrayBuffer);
          sendMessage('transcribe', { dataId, audioBase64 });
        } catch (err) {
          resultEl.textContent = (err && err.message) || 'Failed to get audio.';
          btn.style.display = 'block';
          divLoading.style.display = 'none';
          delete PendingByRequestId[dataId];
        }
      });

      if (CompletedByRequestId[dataId]) {
        btn.style.display = 'none';
        resultEl.textContent = CompletedByRequestId[dataId];
        resultContainer.style.display = null;
      }

      parakeetContainer.appendChild(btn);
      parakeetContainer.appendChild(divLoading);
      parakeetContainer.appendChild(resultContainer);
      container.appendChild(parakeetContainer);
    }

    const observer = new MutationObserver(function (mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const spans = node.querySelectorAll
            ? node.parentNode.querySelectorAll(AudioPlaySelector)
            : [];
          for (const span of spans) {
            const container = findParentWithDataId(span);
            if (!container) continue;
            if (container.querySelector('.message-out')) continue;
            try {
              attachButtonToContainer(container);
            } catch (err) {
              error(err);
            }
          }
        }
      }
    });

    document.addEventListener(ParakeetMessageTopic, ev => {
      const detail = ev.detail || {};
      const { origin, type } = detail;
      if (origin === 'main') return;

      switch (type) {
        case 'transcribe': {
          const { dataId, transcript, error: err } = detail;
          const pending = PendingByRequestId[dataId];
          if (!pending) return;
          delete PendingByRequestId[dataId];
          pending(err, transcript);
          if (transcript) CompletedByRequestId[dataId] = transcript;
          return;
        }

        case 'i18n.getMessage':
          for (const msg of detail.messages) {
            i18nMessages[msg.key].rs(msg);
          }
          return;

        default:
          warn('Unhandled type:', type);
          return;
      }
    });

    const I18N = await i18nGetMessages(['transcribe', 'transcribing']);

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  } catch (err) {
    error('Unexpected error', err);
  }
})();
