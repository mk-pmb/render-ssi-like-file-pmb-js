/*jslint indent: 2, maxlen: 80, continue: false, unparam: false, node: true */
/* -*- tab-width: 2 -*- */
'use strict';

var CF, PT, noOp = Boolean.bind(null, false),
  nodeFs = require('fs'), resolveRelativePath = require('path').resolve,
  flexiTimeout = require('callback-timeout-flexible'),
  readFileCached = require('readfile-cache-pmb'),
  makeUniqueIdCounter = require('maxuniqid'),
  stringPeeks = require('string-peeks'),
  XmlTag = require('xmlattrdict/xmltag');


function isStr(x, no) { return (((typeof x) === 'string') || no); }
function ifFun(x, d) { return ((typeof x) === 'function' ? x : d); }
function typeofIf(x) { return (x && typeof x); }


CF = function RenderSsiFile(opts) {
  if (!(this instanceof CF)) { return new CF(opts); }
  this.commands = Object.assign({}, PT.commands);
  this.nextUniqId = makeUniqueIdCounter();
  this.segments = null;
  this.pending = {
    inserts: {},
    hooks: {},
  };
  this.phase = 'init';
  this.postFx = [];
  this.lateFx = [];
  this.text = '';
  Object.assign(this, opts);
  if (!this.readFile) { this.readFile = readFileCached.rf(); }
};
PT = CF.prototype;


PT.toString = function () {
  return '['.concat(this.constructor.name, ' ',
    (this.filename || '<no file name>'), ']');
};


PT.readFile = null;   // will be set by constructor
PT.encoding = 'utf-8';
PT.preserveByteOrderMark = true;
PT.defaultFetchTimeoutSec = 0.5;

PT.commands = {       // template for the constructor's independent copy
  '>prefix': '!--#',
  '>suffix': ' --',
};


PT.log = function (level, event, detail) { return [level, event, detail]; };


CF.checkMissingCallback = function (f) {
  if (ifFun(f)) { return; }
  throw new Error('Callback function required');
};


CF.oneLineJSONify = function (x) {
  return JSON.stringify(x, null, 2).replace(/\s*\n\s*/g, ' ');
};


CF.identity = function (x) { return x; };
CF.throwIfTruthy = function (err) { if (err) { throw err; } };
CF.getAnyObjValue = function (obj) { return obj[Object.keys(obj)[0]]; };


CF.normalizeWhitespace = function (text) {
  return String(text).replace(/^[ \t\r]+(\n)/g, '$1'
    ).replace(/\s*$/, '\n');
};


CF.tagToString = function (tag) {
  if (!tag) { tag = this; }
  return ((tag.cmdName ? 'cmd "' + tag.cmdName + '"'
    : 'tag <' + tag.tagName + '>') + ' @ ' + tag.srcPos.fmt());
};


CF.describe = function (x) {
  var d = typeofIf(x);
  switch (d) {
  case '':
  case 'string':
    return JSON.stringify(x);
  case 'object':
    d = String(x);
    try {
      d += ' ' + JSON.stringify(x);
    } catch (jsonifyErr) {
      d += ' ?? ' + String(jsonifyErr);
    }
    return d;
  }
  return String(x);
};


PT.expectPhase = function (want) {
  var phase = this.phase;
  if (phase === want) { return; }
  if (Array.isArray(want) && (want.indexOf(phase) >= 0)) { return; }
  throw new Error('Wrong render phase ' + phase + ', expected ' + want);
};


PT.setSourceText = function (text) {
  this.expectPhase(['init', 'readSourceFile']);
  var normWsp = this.normalizeWhitespace;
  switch (typeofIf(normWsp)) {
  case 'function':
    text = normWsp(text);
    break;
  case 'boolean':   // => true
    text = CF.normalizeWhitespace(text);
    break;
  }
  this.text = text;
  this.log('D', 'setSourceTextOk', [text.slice(0, 128), text.length]);
  this.phase = 'hasSourceText';
  return this;
};


PT.recvSourceText = function (next, fetchErr, text) {
  this.log('D', 'recvSourceText', [fetchErr, text && text.length]);
  this.expectPhase('readSourceFile');
  CF.checkMissingCallback(next);
  if (fetchErr) { return next(fetchErr); }
  try {
    this.setSourceText(text);
  } catch (setTextErr) {
    return next(setTextErr);
  }
  return next(null);
};


PT.readFileRel = function (relFn, encoding, deliver) {
  if (!this.filename) {
    relFn = 'Cannot resolve relative path without source filename: ' + relFn;
    return deliver(new Error(relFn), null);
  }
  var absFn = resolveRelativePath(this.filename, '..', relFn);
  this.log('D', 'readFileRel:resolve', [relFn, absFn]);
  return this.readFile(absFn, encoding, deliver);
};


PT.verifyNonePending = function (what) {
  if (Object.keys(this.pending[what]).length === 0) { return; }
  throw new Error('Callback flow error! We still have pending ' + what + '.');
};


PT.runNextHook = function (qName, whenHookDone) {
  this.verifyNonePending('hooks');
  var self = this, q = this[qName], n = q.length, f = (n ? q.shift() : null);
  this.log('D', 'runNextHook:checkQ', { qName: qName, qLength: n,
    nextHookType: typeofIf(f) });
  if (!n) { return false; }
  if (!ifFun(f)) {
    throw new TypeError('Found non-function hook in Q ' + qName);
  }
  function g(err) {
    delete self.pending.hooks[g.id];
    return whenHookDone(err);
  }
  g.id = qName + '$' + this.nextUniqId();
  self.pending.hooks[g.id] = g;
  return f(this, g);
};


PT.tryAsync = function (mtdName, args, cb) {
  var err = null, val;
  try {
    val = this[mtdName].apply(this, args);
  } catch (caught) {
    err = (caught || ('False-y error: ' + caught));
  }
  return cb(err, val);
};


PT.render = function (whenRendered, err) {
  var phase = this.phase,
    retryRender = this.render.bind(this, whenRendered);
  CF.checkMissingCallback(whenRendered);
  if (err) { return whenRendered(err); }

  if (phase === 'init') {
    if (this.filename) {
      this.log('D', 'render:segments:readFile');
      this.phase = 'readSourceFile';
      this.readFile(this.filename, this.encoding,
        this.recvSourceText.bind(this, retryRender));
      return;
    }
    this.log('D', 'render:segments:init');
  }

  if (!this.segments) {
    this.verifyNonePending('inserts');
    return this.tryAsync('tokenize', [], retryRender);
  }

  if (phase === 'tokenized') {
    return this.fetchPendingInserts(retryRender);
  }
  if (phase === 'fetchedAllInserts') {
    this.verifyNonePending('inserts');
    return this.tryAsync('mergeSegments', [], retryRender);
  }

  this.expectPhase('segmentsMerged');
  this.verifyNonePending('inserts');
  if (this.runNextHook('postFx', retryRender)) { return; }
  if (this.runNextHook('lateFx', retryRender)) { return; }
  return whenRendered(null, this);
};


PT.tokenize = function () {
  var self = this, buf, seg = [], tag,
    tagStart = '<' + (this.commands['>prefix'] || '');
  this.expectPhase(['init', 'hasSourceText']);
  this.phase = 'tokenizing';
  buf = stringPeeks.fromText(this.text);
  this.byteOrderMark = buf.byteOrderMark;
  buf.willDrain(function () {
    while (buf.eatUntilMarkOrEnd(tagStart, { collect: seg, eatMark: false })) {
      tag = self.tokenizeMaybeTag(buf, seg);
      if (tag) {
        tag = self.foundTag(tag, buf);
        switch (tag && (typeof tag) && tag.insertType) {
        case 'fetcher':
          self.pending.inserts[seg.length] = tag;
          break;
        }
        seg[seg.length] = tag;
      }
    }
  });
  this.segments = seg;
  this.phase = 'tokenized';
  return this;
};


PT.tokenizeMaybeTag = function (buf, seg) {
  var tag = buf.peekTag(), tagPrefix = this.commands['>prefix'],
    tagSuffix = this.commands['>suffix'];
  if (!tag) {
    if (seg) { buf.eatUntilMarkOrEnd(1, { collect: seg }); }
    // ^--- the invocation without `seg` is a feature for command handlers
    //      to help them invoke other command handlers without modifying
    //      `buf` if their suspect code wasn't a tag.
    return false;
  }
  if (tagSuffix) {
    if (!tag.endsWith(tagSuffix)) {
      if (seg) { seg.push(buf.eat()); }
      return false;
    }
    tag = tag.slice(0, -tagSuffix.length);
  }
  if (isStr(tag)) { tag = new XmlTag(tag); }
  if (tagPrefix) {
    if (!tag.tagName.startsWith(tagPrefix)) {
      if (seg) { seg.push(buf.eat()); }
      return false;
    }
    tag.cmdName = tag.tagName.slice(tagPrefix.length);
  }
  tag.srcPos = buf.calcPosLnChar();
  tag.toString = CF.tagToString;
  tag.origText = buf.eat();
  return tag;
};


PT.foundTag = function (tag, buf) {
  var val, meta = {};
  if (!tag) { throw new Error('missing tag'); }
  if (!isStr(tag.origText)) {
    throw new Error('missing tag.origText on tag (' +
      (typeof tag) + ') "' + tag + '"');
  }
  val = this.applyCmdFunc('>before', val, tag, buf);
  val = this.applyCmdFunc((tag.cmdName || ('<' + tag.tagName)),
    val, tag, buf, meta);
  if (!meta.func) {
    val = this.applyCmdFunc('>other', val, tag, buf, meta);
  }
  val = this.applyCmdFunc('>after', val, tag, buf);
  switch (typeofIf(val)) {
  case undefined:
  case null:
  case false:
    return tag.origText;
    // We can skip the entire match without risk of missing anything,
    // since there can't be a "<" inside a tag.
  case '':
  case 'string':
    return val;
  case 'function':
    return { insertType: 'fetcher', fetcher: val, tag: tag };
  }
  throw tag.err('Unsupported return value from command handler: ' + val);
};


PT.applyCmdFunc = function (func, val, tag, buf, meta) {
  var hnd = this.commands[func];
  this.log('D', 'applyCmdFunc:resolve',
    { func: func, hndType: typeofIf(hnd) });
  if (isStr(hnd)) { hnd = (this.commands[hnd] || CF[hnd]); }
  if (!ifFun(hnd)) { return val; }
  if (meta) { meta.func = hnd; }
  this.log('D', 'applyCmdFunc:call',
    { func: func, hndType: typeofIf(hnd) });
  return hnd.call(this, val, tag, buf);
};


PT.fetchPendingInserts = function (whenAllFetched) {
  var self = this, todo = Object.keys(self.pending.inserts), recvOneSeg;
  this.expectPhase('tokenized');
  this.phase = 'fetchingInserts';
  if (!self.failedInserts) { self.failedInserts = {}; }
  if (todo.length < 1) {
    this.phase = 'fetchedAllInserts';
    return whenAllFetched(null, self);
  }
  recvOneSeg = this.receiveFetchedSegment.bind(this, whenAllFetched);
  try {
    todo = todo.map(this.prepareFetchOneInsert.bind(this, recvOneSeg));
  } catch (prepErr) {
    prepErr.message = 'Failed to start deferred rendering: ' + prepErr.message;
    return whenAllFetched(prepErr);
  }
  todo.forEach(function (how) { how(); });
};


PT.prepareFetchOneInsert = function (rcv, idx) {
  var pend = this.pending.inserts, ins = pend[idx],
    how = 'fetchOneInsert_' + ins.insertType, proxy;
  how = (this[how] || how);
  this.log('D', 'fetchPendingInserts:prepareTodo', [idx, ins, how]);
  if (ifFun(how)) {
    proxy = function RenderSsiFile_hasOneInsert(er, tx) { rcv(idx, er, tx); };
    return how.bind(this, ins, proxy, idx);
  }
  throw new Error('unsupported insert type: ' + CF.describe(ins));
};


function wrapError(origErr, intro, extras) {
  if (!origErr) { return null; }
  intro = (intro || '');
  var bettErr = new Error(intro + String(origErr.message || origErr));
  if (origErr.stack) { bettErr.stack = intro + origErr.stack; }
  if (extras) { Object.assign(bettErr, extras); }
  return bettErr;
}


PT.receiveFetchedSegment = function (whenAllFetched, idx, err, text) {
  var fetcher = this.pending.inserts[idx], tag;
  if (!fetcher) {
    this.log('W', 'inserts:received_nonpending', [idx, err, text]);
    return;
  }
  if (err) {
    this.segments[idx] = err;
    this.failedInserts[idx] = { fetcher: fetcher, err: err };
  } else {
    tag = (fetcher.tag || false);
    if (tag.filterFetchedText) { text = tag.filterFetchedText(text); }
    this.segments[idx] = text;
  }
  delete this.pending.inserts[idx];
  this.expectPhase('fetchingInserts');
  if (Object.keys(this.pending.inserts).length > 0) { return; }
  this.phase = 'fetchedAllInserts';
  err = wrapError((CF.getAnyObjValue(this.failedInserts) || false).err,
    'Errors in deferred rendering, see .failedInserts. One of them: ',
    { failedInserts: this.failedInserts });
  return whenAllFetched(err, this);
};


PT.fetchOneInsert_fetcher = function (ins, whenReceived) {
  var tmo = flexiTimeout(whenReceived, {
    limitSec: (ins.fetcher.fetchTimeoutSec || this.defaultFetchTimeoutSec),
    name: 'content fetcher for ' + String(ins.tag),
    errMsg: 'No feedback from \v{name}',
  });
  this.log('D', 'fetchOneInsert_fetcher', String(tmo));
  setImmediate(function fetchOneInsert_proxy() { return ins.fetcher(tmo); });
};


function stringifySegment(seg, idx) {
  if (isStr(seg)) { return seg; }
  throw new Error('Segment #' + idx + ': unsupported segment type: '
    + CF.describe(seg));
}


PT.mergeSegments = function () {
  this.text = this.segments.map(stringifySegment).join('');
  this.phase = 'segmentsMerged';
};


PT.getText = function () {
  var text = this.text;
  if (text === null) { throw new Error('not .render()ed'); }
  return text;
};

PT.getOutputBOM = function () {
  return ((this.preserveByteOrderMark && this.byteOrderMark) || '');
};















PT.saveToFile = function (destFn, whenSaved) {
  var text = this.getOutputBOM() + this.getText();
  if (destFn === '-') {
    process.stdout.write(text);
    return (whenSaved && whenSaved(null));
  }
  nodeFs.writeFile(destFn, text, { encoding: this.encoding }, whenSaved);
};




CF.rejectLeftoverAttrs = function (text, tag) {
  if (arguments.length === 1) { tag = text; }
  var leftover = Object.keys(tag.attrs);
  if (leftover.length === 0) { return text; }
  leftover = CF.oneLineJSONify(tag.attrs);
  throw tag.err('leftover attributes: ' + leftover);
};


CF.fromFile = function (srcFn, deliver) {
  var ssiFile = new CF();
  ssiFile.filename = srcFn;
  return ssiFile.render(deliver);
};







module.exports = CF;
if (require.main === module) { CF.fromFile('index.shtml', process); }
