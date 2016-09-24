/*jslint indent: 2, maxlen: 80, continue: false, unparam: false, node: true */
/* -*- tab-width: 2 -*- */
'use strict';

var CF, PT, noOp = Boolean.bind(null, false),
  nodeFs = require('fs'), resolveRelativePath = require('path').resolve,
  flexiTimeout = require('callback-timeout-flexible'),
  readFileCached = require('readfile-cache-pmb'),
  StringPeeks = require('string-peeks'),
  XmlTag = require('xmlattrdict/xmltag');


CF = function RenderSsiFile(opts) {
  if (!(this instanceof CF)) { return new CF(opts); }
  this.commands = Object.assign({}, PT.commands);
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


CF.checkMissingCallback = function (func) {
  if ((typeof func) === 'function') { return; }
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
  var d = (x && typeof x);
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


PT.setSourceText = function (text) {
  if (this.checkHasMagicTokens()) {
    throw new Error('Cannot set source: already tokenized');
  }
  var normWsp = this.normalizeWhitespace;
  switch (normWsp && typeof normWsp) {
  case 'function':
    text = normWsp(text);
    break;
  case 'boolean':   // => true
    text = CF.normalizeWhitespace(text);
    break;
  }
  this.segments = [text];
  this.log('D', 'setSourceTextOk', [text.slice(0, 128), text.length]);
  return this;
};


PT.recvSourceText = function (next, fetchErr, text) {
  this.log('D', 'recvSourceText', [fetchErr, text && text.length]);
  CF.checkMissingCallback(next);
  if (fetchErr) { return next(fetchErr); }
  try {
    this.setSourceText(text);
  } catch (setTextErr) {
    return next(setTextErr);
  }
  return next(null);
};


PT.checkHasMagicTokens = function () {
  var seg = (this.segments || false);
  if ((seg.length || 0) < 1) { return false; }
  if ((seg.length === 1) && ((typeof seg[0]) === 'string')) { return false; }
  return true;
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


PT.render = function (whenRendered, err) {
  var retryRender = this.render.bind(this, whenRendered);
  CF.checkMissingCallback(whenRendered);
  if (err) { return whenRendered(err); }
  if (!this.segments) {
    this.segments = [];     // prevent infinite recursion
    this.log('D', 'render:segments:init');
    if (this.filename) {
      this.log('D', 'render:segments:readFile');
      this.readFile(this.filename, this.encoding,
        this.recvSourceText.bind(this, retryRender));
      return;
    }
  }
  if (!this.pendingInserts) {
    try {
      this.tokenize();
    } catch (tokenizeErr) {
      return whenRendered(tokenizeErr, this);
    }
    this.fetchPendingInserts(retryRender);
    return;
  }
  if (Object.keys(this.pendingInserts).length) {
    throw new Error('Cannot render() while there are still pendingInserts!');
  }
  return whenRendered(null, this);
};


PT.tokenize = function () {
  var self = this, buf, seg = [], tag,
    tagStart = '<' + (this.commands['>prefix'] || '');
  if (this.checkHasMagicTokens()) { return 'already tokenized'; }
  if (!this.pendingInserts) { this.pendingInserts = {}; }
  buf = new StringPeeks(this.segments[0]);
  this.byteOrderMark = buf.byteOrderMark;
  buf.willDrain(function () {
    while (buf.eatUntilMarkOrEnd(tagStart, seg)) {
      tag = self.tokenizeMaybeTag(buf, seg);
      if (tag) {
        tag = self.foundTag(tag, buf);
        switch (tag && (typeof tag) && tag.insertType) {
        case 'fetcher':
          self.pendingInserts[seg.length] = tag;
          break;
        }
        seg[seg.length] = tag;
      }
    }
  });
  this.segments = seg;
  return this;
};


PT.tokenizeMaybeTag = function (buf, seg) {
  var tag = buf.peekTag(), tagPrefix = this.commands['>prefix'],
    tagSuffix = this.commands['>suffix'];
  if (!tag) {
    if (seg) { buf.eatUntilMarkOrEnd(1, seg); }
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
  if ((typeof tag) === 'string') { tag = new XmlTag(tag); }
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
  if ((typeof tag.origText) !== 'string') {
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
  switch (val && typeof val) {
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
  func = this.commands[func];
  if ((typeof func) === 'string') { func = (this.cmd[func] || CF[func]); }
  if ((typeof func) !== 'function') { return val; }
  if (meta) { meta.func = func; }
  return func.call(this, val, tag, buf);
};


PT.fetchPendingInserts = function (whenAllFetched) {
  var self = this, todo = Object.keys(self.pendingInserts), recvOneSeg;
  if (!self.failedInserts) { self.failedInserts = {}; }
  if (todo.length < 1) { return whenAllFetched(null, self); }
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
  var pend = this.pendingInserts, ins = pend[idx],
    how = 'fetchOneInsert_' + ins.insertType, proxy;
  how = (this[how] || how);
  this.log('D', 'fetchPendingInserts:prepareTodo', [idx, ins, how]);
  if ((typeof how) === 'function') {
    proxy = function RenderSsiFile_hasOneInsert(er, tx) { rcv(idx, er, tx); };
    return how.bind(this, ins, proxy, idx);
  }
  throw new Error('unsupported insert type: ' + CF.describe(ins));
};


PT.receiveFetchedSegment = function (whenAllFetched, idx, err, text) {
  var fetcher = this.pendingInserts[idx], tag;
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
  delete this.pendingInserts[idx];
  if (Object.keys(this.pendingInserts).length > 0) { return; }
  err = (CF.getAnyObjValue(this.failedInserts) || false).err;
  if (err) {
    err = new Error('Errors in deferred rendering, see .failedInserts.'
      + ' One of them: ' + String(err.message || err));
    err.failedInserts = this.failedInserts;
    return whenAllFetched(err, this);
  }
  return whenAllFetched(null, this);
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


PT.getText = function () {
  if (!Array.isArray(this.segments)) { throw new Error('not .render()ed'); }
  var bom = (this.preserveByteOrderMark && this.byteOrderMark);
  return (bom || '') + this.segments.map(function (seg, idx) {
    switch (seg && typeof seg) {
    case '':
    case 'string':
      return seg;
    }
    throw new Error('Segment #' + idx + ': unsupported segment type: '
      + CF.describe(seg));
  }).join('');
};

















PT.saveToFile = function (destFn, whenSaved) {
  var newText = this.getText();
  if (destFn === '-') {
    process.stdout.write(newText);
    return (whenSaved && whenSaved(null));
  }
  nodeFs.writeFile(destFn, newText, { encoding: this.encoding }, whenSaved);
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
  if (deliver === process) {
    srcFn = (process.argv[2] || srcFn);
    deliver = function (err, text) {
      if (err) { throw err; }
      console.log(text);
    };
  }
  ssiFile.filename = srcFn;
  return ssiFile.render(deliver);
};







module.exports = CF;
if (require.main === module) { CF.fromFile('index.shtml', process); }
