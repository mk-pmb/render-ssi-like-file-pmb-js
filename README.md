
<!--#echo json="package.json" key="name" underline="=" -->
render-ssi-like-file-pmb
========================
<!--/#echo -->

<!--#echo json="package.json" key="description" -->
Replace SSI-style command tags in a text file.
<!--/#echo -->


Usage
-----

The designated usage example for this rendering framework is
[readme-ssi](https://github.com/mk-pmb/readme-ssi).



Known issues
------------

* The callback hell has grown beyond repair, I've given up on proper
  error tracking. Needs to be rewritten in ES6 with Promises.



<!--#toc stop="scan" -->


License
-------
<!--#echo json="package.json" key=".license" -->
ISC
<!--/#echo -->
