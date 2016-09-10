
render-ssi-like-file-pmb
========================
Replace SSI-style command tags in a text (file).


Usage
-----
:TODO:

```javascript
var ssiLikeFile = require('render-ssi-like-file-pmb');
ssiLikeFile.fromFile('index.shtml').render(function report(err, file) {
  if (err) { return console.error(err); }
  console.log(file.getText());
});
```


License
-------
ISC
