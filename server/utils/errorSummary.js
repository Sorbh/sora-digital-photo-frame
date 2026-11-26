// What a log may say about an error: its name, code and status and the top of its
// stack. Never its message (a hook's error can quote a PIN, a family code or part of
// a request) or its own fields (a body a library attached).

// "    at fn (/path/file.js:10:5)", "    at /path/file.js:10:5", "    at node:internal/x:1:2"
const FRAME = /^ {4}at (?:(?:new |async )?[\w$.<>[\] ]+ \()?(?:node:[\w/.-]+|file:\/\/\S+|\/[^\s()]+|[A-Za-z]:\\[^()]+):\d+:\d+\)?$/;
const MAX_FRAMES = 5;

function errorFrames(err) {
  if (typeof err.stack !== 'string') return [];
  // The stack starts with "Name: message", which may run over several lines: skip
  // exactly that text, so a line of the message can never pass for a frame
  const head = String(err);
  if (!err.stack.startsWith(head)) return [];
  return err.stack.slice(head.length).split('\n').filter(line => FRAME.test(line)).slice(0, MAX_FRAMES);
}

// A code is logged only when it looks like one (ENOENT, QUOTA_EXCEEDED, ERR_...):
// a hook could put anything there, a family code included
const CODE = /^(?:[A-Z][A-Z0-9_]{1,40}|ERR_[A-Za-z0-9_]{1,60})$/;
const safeCode = code => (code === undefined || code === null || code === '' ? null : (CODE.test(String(code)) ? String(code) : '[redacted]'));
const safeName = name => (typeof name === 'string' && /^[A-Za-z][\w$]{0,60}$/.test(name) ? name : 'Error');

function errorSummary(err) {
  if (!err || typeof err !== 'object') return 'unknown error';
  const status = Number.isInteger(err.status) ? err.status : null;
  const label = [safeName(err.name), safeCode(err.code), status].filter(Boolean).join(' ');
  return [label, ...errorFrames(err)].join('\n');
}

module.exports = { errorSummary, errorFrames };
