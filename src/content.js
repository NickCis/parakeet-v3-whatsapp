const ContentLogPrefix = '[Parakeet-WA content]';
console.log(ContentLogPrefix, 'script loaded');

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

document.addEventListener(EventRequestTranscribe, async function (ev) {
  const detail = ev.detail || {};
  const { requestId, audioBase64 } = detail;
  if (requestId == null || !audioBase64 || typeof audioBase64 !== 'string') {
    console.warn(ContentLogPrefix, 'ignoring: missing requestId or audioBase64');
    return;
  }
  console.log(ContentLogPrefix, 'sending to background', 'requestId=', requestId, 'audioBase64.length=', audioBase64.length);

  const sendResult = function (payload) {
    document.dispatchEvent(
      new CustomEvent(EventTranscriptResult, {
        detail: Object.assign({ requestId }, payload),
      }),
    );
  };

  try {
    const reply = await chrome.runtime.sendMessage({ type: 'transcribe', audioBase64 });
    if (reply && reply.error) {
      sendResult({ error: reply.error });
    } else if (reply && reply.transcript != null) {
      sendResult({ transcript: reply.transcript || '' });
    } else {
      sendResult({ error: getMessage('error_transcribe') });
    }
  } catch (err) {
    console.error(ContentLogPrefix, 'error:', err);
    sendResult({ error: (err && err.message) || getMessage('error_transcribe') });
  }
});

try {
  injectScript('main.js');
} catch (err) {
  console.error(ContentLogPrefix, 'Failed to load main.js:', err);
}
