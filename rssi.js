/*jslint indent: 2, maxlen: 80, continue: false, unparam: false, node: true */
/* -*- tab-width: 2 -*- */
'use strict';

var CF, PT, noOp = Boolean.bind(null, false),
  nodeFs = require('fs'), readFileCached = require('readfile-cache-pmb');


CF = function ReadmeSSI(opts) {
  if (!(this instanceof CF)) { return new CF(opts); }
  Object.assign(this, opts);
  if (!this.readFile) { this.readFile = readFileCached.rf(); }
  this.debugLog = CF.configureDebugLog(this.debugLog);
};
PT = CF.prototype;


PT.toString = function () {
  return '['.concat(this.constructor.name, ' ',
    (this.filename || '<no file name>'), ']');
};


PT.readFile = null;   // will be
PT.encoding = 'utf-8';
PT.tocPfx = '### ';
PT.tocFmt = '  * [&$caption;](#&$githubdash;)';

CF.markDown = {
  codeBlockQuotes: '```',
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


CF.throwIfTruthy = function (err) { if (err) { throw err; } };


PT.render = function (whenRendered) {
  EX.checkMissingCallback(whenRendered);
  if (!this.lines) {
    this.lines = 'fetching…';     // prevent infinite recursion
    if (this.filename) {
      this.readFile(this.filename, this.encoding, function (err, text) {
        if (err) { return whenRendered(err); }
        this.setSourceText(text);
        return this.render(whenRendered);
      };
      return;
    }
  }
  if (!this.pendingInserts) {
    try {
      this.tokenize();
    } catch (tokenizeErr) {
      return whenRendered(tokenizeErr, this);
    }
    this.fetchInserts(this.render.bind(this, whenRendered));
    return;
  }
  if (Object.keys(this.pendingInserts).length) {
    throw new Error('Cannot render() while there are still pendingInserts!');
  }
  return whenRendered(null, this);
};



PT.fetchInserts = function (whenFetched) {
  var
  Object.keys(this.pendingInserts).map(this.fetchInsertBySlotIdx.bind(this));
};

















PT.saveToFile = function (destFn) {
  if (err) { throw err; }
  var newText = readme.getText();
  if (destFn === '-') { return console.log(newText); }
  nodeFs.writeFile(destFn, newText + '\n',
    { encoding: readme.encoding },
    function whenSaved(err) { if (err) { throw err; } });
};




CF.fromFile = function (srcFn, deliver) {
  var ssiFile = new CF();
  if (deliver === process) {
    srcFn = (process.argv[2] || srcFn);
    deliver = function (err, text) {
      if (err) { throw err; }
      console.log(text);
    };
  });
  ssiFile.filename = srcFn;
  return ssiFile.render(deliver);
};







module.exports = CF;
if (require.main === module) { CF.fromFile('index.shtml', process); }
