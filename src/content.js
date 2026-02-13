/**
 * Content script: injects page-context script and bridges transcription.
 * Listens for parakeet-request-transcribe (requestId, arrayBuffer), sends to
 * background, then dispatches parakeet-transcript-result (requestId, transcript/error).
 */

const ContentLogPrefix = '[Parakeet-WA content]';
console.log(ContentLogPrefix, 'script loaded');

function getMessage(key) {
  try {
    return chrome.i18n.getMessage(key) || key;
  } catch {
    return key;
  }
}

function injectPageScript() {
  chrome.runtime.sendMessage({ type: 'injectPageScript' }, function (reply) {
    if (reply && reply.ok) {
      console.log(
        ContentLogPrefix,
        'page-context script injected via scripting API',
      );
    } else if (reply && reply.error) {
      console.error(ContentLogPrefix, 'injectPageScript failed:', reply.error);
    }
  });
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
    const reply = await chrome.runtime.sendMessage({
      type: 'transcribe',
      audioBase64,
    });
    console.log(
      ContentLogPrefix,
      'reply from background:',
      reply ? Object.keys(reply) : reply,
    );
    if (reply && reply.error) {
      sendResult({ error: reply.error });
    } else if (reply && reply.transcript != null) {
      sendResult({ transcript: reply.transcript || '' });
    } else {
      sendResult({ error: getMessage('error_transcribe') });
    }
  } catch (err) {
    console.error(ContentLogPrefix, 'error:', err);
    sendResult({
      error: (err && err.message) || getMessage('error_transcribe'),
    });
  }
});

function main() {
  injectPageScript();
}

if (document.body) {
  console.log(ContentLogPrefix, 'body exists');
  main();
} else {
  console.log(ContentLogPrefix, 'waiting for DOMContentLoaded');
  document.addEventListener('DOMContentLoaded', function () {
    console.log(ContentLogPrefix, 'DOMContentLoaded');
    main();
  });
}
