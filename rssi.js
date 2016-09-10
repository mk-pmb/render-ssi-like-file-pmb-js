/*jslint indent: 2, maxlen: 80, continue: false, unparam: false, node: true */
/* -*- tab-width: 2 -*- */
'use strict';

var CF, PT, noOp = Boolean.bind(null, false),
  nodeFs = require('fs'),
  readFileCached = require('readfile-cache-pmb'),
  StringPeeks = require('string-peeks'),
  xmlAttrDict = require('xmlattrdict');


CF = function ReadmeSSI(opts) {
  if (!(this instanceof CF)) { return new CF(opts); }
  this.commands = Object.assign({}, PT.commands);
  Object.assign(this, opts);
  if (!this.readFile) { this.readFile = readFileCached.rf(); }
  this.debugLog = CF.configureDebugLog(this.debugLog);
};
PT = CF.prototype;


PT.toString = function () {
  return '['.concat(this.constructor.name, ' ',
    (this.filename || '<no file name>'), ']');
};


PT.readFile = null;   // will be set by constructor
PT.encoding = 'utf-8';
PT.preserveByteOrderMark = true;

PT.commands = {       // template for the constructor's independent copy
  '>prefix': '!--#',
};



CF.configureDebugLog = function (dl) {
  if (!dl) { return noOp; }
  if ((typeof dl) === 'function') { return dl; }
  if (dl === true) { dl = 'D:'; }
  dl = String(dl);
  return console.error.bind(console, dl);
};


CF.checkMissingCallback = function (func) {
  if ((typeof func) === 'function') { return; }
  throw new Error('Callback function required');
};


CF.identity = function (x) { return x; };
CF.throwIfTruthy = function (err) { if (err) { throw err; } };




PT.setSourceText = function (text) {
  if (this.checkHasMagicTokens()) {
    throw new Error('Cannot set source: already tokenized');
  }
  this.segments = [text];
  return this;
};


PT.checkHasMagicTokens = function () {
  var seg = (this.segments || false);
  if ((seg.length || 0) < 1) { return false; }
  if ((seg.length === 1) && ((typeof seg[0]) === 'string')) { return false; }
  return true;
};


PT.render = function (whenRendered) {
  var self = this;
  CF.checkMissingCallback(whenRendered);
  if (!self.segments) {
    self.segments = [];     // prevent infinite recursion
    if (self.filename) {
      self.readFile(self.filename, self.encoding, function (err, text) {
        if (err) { return whenRendered(err); }
        try {
          self.setSourceText(text);
        } catch (setTextErr) {
          return whenRendered(setTextErr, self);
        }
        return self.render(whenRendered);
      });
      return;
    }
  }
  if (!self.pendingInserts) {
    try {
      self.tokenize();
    } catch (tokenizeErr) {
      return whenRendered(tokenizeErr, self);
    }
    self.fetchPendingInserts(self.render.bind(self, whenRendered));
    return;
  }
  if (Object.keys(self.pendingInserts).length) {
    throw new Error('Cannot render() while there are still pendingInserts!');
  }
  return whenRendered(null, self);
};


PT.tokenize = function () {
  var self = this, buf, seg = [];
  if (this.checkHasMagicTokens()) { return 'already tokenized'; }
  if (!this.pendingInserts) { this.pendingInserts = {}; }
  buf = new StringPeeks(this.segments[0]);
  this.byteOrderMark = buf.byteOrderMark;
  buf.willDrain(function (tag) {
    while (buf.eatUntilMarkOrEnd('<', seg)) {
      tag = buf.peekTag();
      if (tag) {
        tag = self.foundTag(tag, buf);
        if ((typeof tag) === 'function') {
          self.pendingInserts[seg.length] = tag;
        }
        seg[seg.length] = tag;
      } else {
        buf.eatUntilMarkOrEnd(1, seg);
      }
    }
  });
  this.segments = seg;
  return this;
};


PT.foundTag = function (tag, buf) {
  var val, meta = {}, pfx = this.commands['>prefix'];
  if ((typeof tag) === 'string') {
    tag = { tagName: '', attrs: xmlAttrDict('<' + tag + '>') };
    tag.srcPos = buf.calcPosLnChar();
    tag.origText = buf.eat();
    tag.popAttr = xmlAttrDict.popAttr(tag.attrs);
    tag.tagName = tag.popAttr('', '');
  }
  if (pfx) {
    if (!tag.tagName.startsWith(pfx)) { return tag.origText; }
    tag.cmdName = tag.tagName.slice(pfx.length);
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
  case '':
  case 'string':
    return val;
  case 'function':
    return val;
  }
  return this.tagErr(tag, 'Unsupported return value from command handler: ' +
    String(val));
};


PT.tagErr = function (tag, err) {
  tag = (tag.cmdName ? 'cmd "' + tag.cmdName + '"'
    : 'tag <' + tag.tagName + '>') + ' @ ' + tag.srcPos.fmt();
  throw new Error(tag + ': ' + err);
};


PT.applyCmdFunc = function (func, val, tag, buf, meta) {
  func = this.commands[func];
  if ((typeof func) === 'string') { func = (this.cmd[func] || CF[func]); }
  if ((typeof func) !== 'function') { return val; }
  if (meta) { meta.func = func; }
  return func.call(this, val, tag, buf);
};


PT.fetchPendingInserts = function (whenFetched) {
  var self = this, pend = self.pendingInserts, fails = self.failedInserts,
    todo, rcv;
  if (!fails) { fails = self.failedInserts = {}; }
  todo = Object.keys(pend);
  if (todo.length < 1) { return whenFetched(null, self); }
  rcv = function (idx, err) {
    if (err) { fails[idx] = pend[idx]; }
    delete pend[idx];
    if (Object.keys(pend).length > 0) { return; }
    if (Object.keys(fails).length > 0) {
      err = new Error('Errors in deferred rendering, see .failedInserts');
      err.failedInserts = fails;
      return whenFetched(err);
    }
    return whenFetched(null, self);
  };
  todo.forEach(function (idx) {
    self.fetchOneInsert(pend[idx], rcv.bind(self, idx));
  });
};


PT.fetchOneInsert = function (ins, whenReceived) {
  switch (typeof ins) {
  case 'function':
    return setImmediate(ins, whenReceived);
  }
  return whenReceived(new Error('unsupported insert type'));
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
    throw new Error('Segment #' + idx + ': unsupported type: ' + String(seg));
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
  var leftover = Object.keys(tag.attrs);
  if (leftover.length === 0) { return text; }
  leftover = xmlAttrDict.quotedList(leftover);
  return this.tagErr(tag, 'leftover attributes: ' + leftover);
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
