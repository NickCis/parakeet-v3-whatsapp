const ParakeetMessageTopic = 'parakeet-message';
const AudioPlaySelector = 'span[data-icon="audio-play"]';
const DataIdAttr = 'data-id';
const LogPrefix = '[Parakeet-WA content]';

function log(...args) {
  console.log(LogPrefix, ...args);
}

function error(...args) {
  console.error(LogPrefix, ...args);
}

function warn(...args) {
  console.warn(LogPrefix, ...args);
}

log('script loaded');

function getMessage(key) {
  try {
    return chrome.i18n.getMessage(key) || key;
  } catch {
    return key;
  }
}

function injectScript(name) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL(name);
  script.type = 'module';
  document.head.appendChild(script);
}

function sendMessage(type, payload) {
  document.dispatchEvent(
    new CustomEvent(ParakeetMessageTopic, {
      detail: {
        ...payload,
        origin: 'content-script',
        type,
      },
    }),
  );
}

async function transcribe(detail) {
  const { dataId, audioBase64 } = detail;
  if (dataId == null || !audioBase64 || typeof audioBase64 !== 'string') {
    warn('ignoring: missing dataId or audioBase64');
    return;
  }
  log(
    'sending to background',
    'dataId=',
    dataId,
    'audioBase64.length=',
    audioBase64.length,
  );

  const sendResult = function (payload) {
    return sendMessage('transcribe', {
      ...payload,
      dataId,
    });
  };

  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'transcribe',
      audioBase64,
    });
    if (reply && reply.error) {
      sendResult({ error: reply.error });
    } else if (reply && reply.transcript != null) {
      sendResult({ transcript: reply.transcript || '' });
    } else {
      sendResult({ error: getMessage('error_transcribe') });
    }
  } catch (err) {
    error('error:', err);
    sendResult({
      error: (err && err.message) || getMessage('error_transcribe'),
    });
  }
}

document.addEventListener(ParakeetMessageTopic, async ev => {
  const detail = ev.detail || {};
  const { origin, type } = detail;
  if (origin === 'content-script') return;

  switch (type) {
    case 'i18n.getMessage':
      sendMessage('i18n.getMessage', {
        messages: detail.keys.map(key => ({
          key,
          message: getMessage(key),
        })),
      });
      return;

    case 'transcribe':
      transcribe(detail);
      return;

    default:
      warn('Unhandled type:', type);
  }
});

try {
  injectScript('main.js');
} catch (err) {
  error('Failed to load main.js:', err);
}
