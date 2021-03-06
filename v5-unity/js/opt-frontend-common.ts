// Python Tutor: https://github.com/pgbovine/OnlinePythonTutor/
// Copyright (C) Philip Guo (philip@pgbovine.net)
// LICENSE: https://github.com/pgbovine/OnlinePythonTutor/blob/master/LICENSE.txt

/* TODO

- we're always referring to top-level CSS selectors on the page; maybe
  use a this.domRoot pattern like in pytutor.ts?

- test session_uuid, user_uuid, and other stuff stored to localStorage

- test that deltaObj is being properly updated

*/

/// <reference path="_references.ts" />

// for TypeScript
declare var TogetherJS: any;
declare var TogetherJSConfig_ignoreForms: any;
declare var diff_match_patch: any;
declare var codeopticonUsername: string; // FIX later when porting Codeopticon
declare var codeopticonSession: string;  // FIX later when porting Codeopticon


require('./lib/diff_match_patch.js');
require('./lib/jquery.ba-dotimeout.min.js');

var pytutor = require('./pytutor.ts');
var assert = pytutor.assert;


// these settings are all customized for my own server setup,
// so you will need to customize for your server:
const serverRoot = (window.location.protocol === 'https:') ?
                    'https://cokapi.com:8001/' : // my certificate for https is registered via cokapi.com, so use it for now
                    'http://104.237.139.253:3000/';

export const JS_JSONP_ENDPOINT = serverRoot + 'exec_js_jsonp'; // TODO: get rid of this dependency in opt-live.ts

// note that we use '2' and '3' instead of 'py2' and 'py3' due to legacy reasons
const langSettingToBackendScript = {
  // backend scripts to execute (Python 2 and 3 variants, if available)
  // make two copies of ../web_exec.py and give them the following names,
  // then change the first line (starting with #!) to the proper version
  // of the Python interpreter (i.e., Python 2 or Python 3).
  // Note that your hosting provider might have stringent rules for what
  // kind of scripts are allowed to execute. For instance, my provider
  // (Webfaction) seems to let scripts execute only if permissions are
  // something like:
  // -rwxr-xr-x 1 pgbovine pgbovine 2.5K Jul  5 22:46 web_exec_py2.py*
  // (most notably, only the owner of the file should have write
  //  permissions)
  '2': 'web_exec_py2.py',
  '3': 'web_exec_py3.py',

  // empty dummy scripts just to do logging on Apache server
  'js':   'web_exec_js.py',
  'ts':   'web_exec_ts.py',
  'java': 'web_exec_java.py',
  'ruby': 'web_exec_ruby.py',
  'c':   'web_exec_c.py',
  'cpp': 'web_exec_cpp.py',
};

// see ../../v4-cokapi/cokapi.js for details
const langSettingToJsonpEndpoint = {
  '2':    null,
  '3':    null,
  'js':   serverRoot + 'exec_js_jsonp',
  'ts':   serverRoot + 'exec_ts_jsonp',
  'java': serverRoot + 'exec_java_jsonp',
  'ruby': serverRoot + 'exec_ruby_jsonp',
  'c':    serverRoot + 'exec_c_jsonp',
  'cpp':  serverRoot + 'exec_cpp_jsonp',
};


// for shared sessions ... put back in later
//var executeCodeSignalFromRemote = false;
//var togetherjsSyncRequested = false;


// the main event!
//
// NB: this still relies on global state such as localStorage and the
// browser URL hash string, so you still can't have more than one of these
// objects per page; should still be instantiated as a SINGLETON
export abstract class AbstractBaseFrontend {
  sessionUUID: string = generateUUID(); // remains constant throughout one page load ("session")

  myVisualizer; // singleton ExecutionVisualizer instance from pytutor.ts
  originFrontendJsFile: string; // "abstract" -- must override in subclass

  // 'edit' or 'display'. also support 'visualize' for backward
  // compatibility (same as 'display')
  appMode: string = 'edit';

  // inputted by user for raw_input / mouse_input events
  rawInputLst: string[] = [];

  isExecutingCode: boolean = false;

  // optional: not all frontends keep track of deltas
  dmp = new diff_match_patch();
  curCode = ''; // for dmp snapshots, kinda kludgy
  deltaObj : {start: string, deltas: any[], v: number, startTime: number, executeTime?: number} = undefined;

  num414Tries = 0;

  abstract executeCode(forceStartingInstr?: number, forceRawInputLst?: string[]) : any;
  abstract finishSuccessfulExecution() : any;
  abstract handleUncaughtException(trace: any[]) : any;

  constructor(params: any = {}) {
    // optional params -- TODO: handle later
    /*
    if (params.TogetherjsReadyHandler) {
      TogetherjsReadyHandler = params.TogetherjsReadyHandler;
    }
    if (params.TogetherjsCloseHandler) {
      TogetherjsCloseHandler = params.TogetherjsCloseHandler;
    }
    if (params.startSharedSession) {
      startSharedSession = params.startSharedSession;
    }
    */

    if (supports_html5_storage()) {
      // generate a unique UUID per "user" (as indicated by a single browser
      // instance on a user's machine, which can be more precise than IP
      // addresses due to sharing of IP addresses within, say, a school
      // computer lab)
      // added on 2015-01-27 for more precise user identification
      if (!localStorage.getItem('opt_uuid')) {
        localStorage.setItem('opt_uuid', generateUUID());
      }
    }

    // register a generic AJAX error handler
    $(document).ajaxError(function(evt, jqxhr, settings, exception) {
      // ignore errors related to togetherjs stuff:
      if (settings.url.indexOf('togetherjs') > -1) {
        return; // get out early
      }

      // ugh other idiosyncratic errors to ignore
      if ((settings.url.indexOf('name_lookup.py') > -1) ||
          (settings.url.indexOf('syntax_err_survey.py') > -1) ||
          (settings.url.indexOf('viz_interaction.py') > -1)) {
        return; // get out early
      }

      // On my server ...

      // This jqxhr.responseText might mean the URL is too long, since the error
      // message returned by the server is something like this in nginx:
      //
      //   <html>
      //   <head><title>414 Request-URI Too Large</title></head>
      //   <body bgcolor="white">
      //   <center><h1>414 Request-URI Too Large</h1></center>
      //   <hr><center>nginx</center>
      //   </body>
      //   </html>
      //
      // Note that you'll probably need to customize this check for your server.
      if (jqxhr && jqxhr.responseText.indexOf('414') >= 0) {
        // ok this is an UBER UBER hack. If this happens just once, then
        // force click the "Visualize Execution" button again and re-try.
        // why? what's the difference the second time around? the diffs_json
        // parameter (derived from deltaObj) will be *empty* the second time
        // around since it gets reset on every execution. if diffs_json is
        // HUGE, then that might force the URL to be too big without your
        // code necessarily being too big, so give it a second shot with an
        // empty diffs_json. if it STILL fails, then display the error
        // message and give up.
        if (this.num414Tries === 0) {
          this.num414Tries++;
          $("#executeBtn").click();
        } else {
          this.num414Tries = 0;
          this.setFronendError(["Server error! Your code might be too long for this tool. Shorten your code and re-try."]);
        }
      } else {
        this.setFronendError(
                        ["Server error! Your code might be taking too much time to run or using too much memory.",
                         "Report a bug to philip@pgbovine.net by clicking the 'Generate permanent link' button",
                         "at the bottom of this page and including a URL in your email."]);
      }
      this.doneExecutingCode();
    });

    this.clearFrontendError();
    $("#embedLinkDiv").hide();
    $("#executeBtn")
      .attr('disabled', false)
      .click(this.executeCodeFromScratch.bind(this));
  }

  // empty stub so that our code doesn't crash.
  // TODO: override this with a version in codeopticon-learner.js if needed
  logEventCodeopticon(obj) { } // NOP

  setFronendError(lines) {
    $("#frontendErrorOutput").html(lines.map(pytutor.htmlspecialchars).join('<br/>'));
  }

  clearFrontendError() {
    $("#frontendErrorOutput").html('');
  }

  // parsing the URL query string hash
  getQueryStringOptions() {
    var ril = $.bbq.getState('rawInputLstJSON');
    var testCasesLstJSON = $.bbq.getState('testCasesJSON');
    // note that any of these can be 'undefined'
    return {preseededCode: $.bbq.getState('code'),
            preseededCurInstr: Number($.bbq.getState('curInstr')),
            verticalStack: $.bbq.getState('verticalStack'),
            appMode: $.bbq.getState('mode'),
            py: $.bbq.getState('py'),
            cumulative: $.bbq.getState('cumulative'),
            heapPrimitives: $.bbq.getState('heapPrimitives'),
            textReferences: $.bbq.getState('textReferences'),
            rawInputLst: ril ? $.parseJSON(ril) : undefined,
            codeopticonSession: $.bbq.getState('cosession'),
            codeopticonUsername: $.bbq.getState('couser'),
            testCasesLst: testCasesLstJSON ? $.parseJSON(testCasesLstJSON) : undefined
            };
  }

  redrawConnectors() {
    if (this.myVisualizer &&
        (this.appMode == 'display' ||
         this.appMode == 'visualize' /* deprecated */)) {
      this.myVisualizer.redrawConnectors();
    }
  }

  getBaseBackendOptionsObj() {
    var ret = {cumulative_mode: ($('#cumulativeModeSelector').val() == 'true'),
               heap_primitives: ($('#heapPrimitivesSelector').val() == 'true'),
               show_only_outputs: false,
               origin: this.originFrontendJsFile};
    return ret;
  }

  getBaseFrontendOptionsObj() {
    var ret = {// tricky: selector 'true' and 'false' values are strings!
                disableHeapNesting: ($('#heapPrimitivesSelector').val() == 'true'),
                textualMemoryLabels: ($('#textualMemoryLabelsSelector').val() == 'true'),
                executeCodeWithRawInputFunc: this.executeCodeWithRawInput.bind(this),

                // always use the same visualizer ID for all
                // instantiated ExecutionVisualizer objects,
                // so that they can sync properly across
                // multiple clients using TogetherJS. this
                // shouldn't lead to problems since only ONE
                // ExecutionVisualizer will be shown at a time
                visualizerIdOverride: '1',
                updateOutputCallback: function() {$('#urlOutput,#embedCodeOutput').val('');},
                startingInstruction: 0,
              };
    return ret;
  }

  executeCodeFromScratch() {
    this.rawInputLst = []; // reset!
    this.executeCode();
  }

  executeCodeWithRawInput(rawInputStr, curInstr) {
    this.rawInputLst.push(rawInputStr);
    console.log('executeCodeWithRawInput', rawInputStr, curInstr, this.rawInputLst);
    this.executeCode(curInstr);
  }

  startExecutingCode() {
    $('#executeBtn').html("Please wait ... executing (takes up to 10 seconds)");
    $('#executeBtn').attr('disabled', true);
    this.isExecutingCode = true;
  }

  doneExecutingCode() {
    $('#executeBtn').html("Visualize Execution");
    $('#executeBtn').attr('disabled', false);
    this.isExecutingCode = false;
  }

  executeCodeAndCreateViz(codeToExec,
                          pyState,
                          backendOptionsObj, frontendOptionsObj,
                          outputDiv) {
      var backendScript = langSettingToBackendScript[pyState];
      assert(backendScript);
      var jsonp_endpoint = langSettingToJsonpEndpoint[pyState]; // maybe null

      var execCallback = (dataFromBackend) => {
        var trace = dataFromBackend.trace;
        var killerException = null;
        // don't enter visualize mode if there are killer errors:
        if (!trace ||
            (trace.length == 0) ||
            (trace[trace.length - 1].event == 'uncaught_exception')) {
          this.handleUncaughtException(trace);

          if (trace.length == 1) {
            killerException = trace[0]; // killer!
            this.setFronendError([trace[0].exception_msg]);
          } else if (trace.length > 0 && trace[trace.length - 1].exception_msg) {
            killerException = trace[trace.length - 1]; // killer!
            this.setFronendError([trace[trace.length - 1].exception_msg]);
          } else {
            this.setFronendError(
                            ["Unknown error. Reload the page and try again. Or report a bug to",
                             "philip@pgbovine.net by clicking on the 'Generate permanent link'",
                             "button at the bottom and including a URL in your email."]);
          }
        } else {
          // fail-soft to prevent running off of the end of trace
          if (frontendOptionsObj.startingInstruction >= trace.length) {
            frontendOptionsObj.startingInstruction = 0;
          }

          if (frontendOptionsObj.runTestCaseCallback) {
            // hacky! DO NOT actually create a visualization! instead call:
            frontendOptionsObj.runTestCaseCallback(trace);
          } else {
            // success!
            this.myVisualizer = new pytutor.ExecutionVisualizer(outputDiv, dataFromBackend, frontendOptionsObj);
            // SUPER HACK -- slip in backendOptionsObj as an extra field
            // NB: why do we do this? for more detailed logging?
            this.myVisualizer.backendOptionsObj = backendOptionsObj;
            this.finishSuccessfulExecution(); // TODO: should we also run this if we're calling runTestCaseCallback?
          }

          // VERY SUBTLE -- reinitialize TogetherJS so that it can detect
          // and sync any new elements that are now inside myVisualizer
          if (typeof TogetherJS !== 'undefined' && TogetherJS.running) {
            TogetherJS.reinitialize();
          }
        }

        // run this at the VERY END after all the dust has settled
        this.doneExecutingCode(); // rain or shine, we're done executing!

        // do logging at the VERY END after the dust settles ... maybe
        // move into opt-frontend.js?
        // and don't do it for iframe-embed.js since getAppState doesn't
        // work in that case ...
        /*
        if (this.originFrontendJsFile !== 'iframe-embed.js') {
          this.logEventCodeopticon({type: 'doneExecutingCode',
                    appState: this.getAppState(),
                    // enough to reconstruct the ExecutionVisualizer object
                    backendDataJSON: JSON.stringify(dataFromBackend), // for easier transport and compression
                    frontendOptionsObj: frontendOptionsObj,
                    backendOptionsObj: backendOptionsObj,
                    killerException: killerException, // if there's, say, a syntax error
                    });
        }
        */

        // tricky hacky reset
        this.num414Tries = 0;
      }

      if (!backendScript) {
        this.setFronendError(
                        ["Server configuration error: No backend script",
                         "Report a bug to philip@pgbovine.net by clicking on the 'Generate permanent link'",
                         "button at the bottom and including a URL in your email."]);
        return;
      }

      /*
      if (typeof TogetherJS !== 'undefined' &&
          TogetherJS.running && !executeCodeSignalFromRemote) {
        TogetherJS.send({type: "executeCode",
                         myAppState: this.getAppState(),
                         forceStartingInstr: frontendOptionsObj.startingInstruction,
                         rawInputLst: this.rawInputLst});
      }
      */

      this.clearFrontendError();
      this.startExecutingCode();

      frontendOptionsObj.lang = pyState;
      // kludgy exceptions
      if (pyState === '2') {
        frontendOptionsObj.lang = 'py2';
      } else if (pyState === '3') {
        frontendOptionsObj.lang = 'py3';
      } else if (pyState === 'java') {
        frontendOptionsObj.disableHeapNesting = true; // never nest Java objects, seems like a good default
      }

      // if we don't have any deltas, then don't bother sending deltaObj:
      // NB: not all subclasses will initialize this.deltaObj
      var deltaObjStringified = (this.deltaObj && (this.deltaObj.deltas.length > 0)) ? JSON.stringify(this.deltaObj) : null;
      if (deltaObjStringified) {
        // if deltaObjStringified is too long, then that will likely make
        // the URL way too long. in that case, just make it null and don't
        // send a delta. we'll lose some info but at least the URL will
        // hopefully not overflow:
        if (deltaObjStringified.length > 4096) {
          //console.log('deltaObjStringified.length:', deltaObjStringified.length, '| too long, so set to null');
          deltaObjStringified = null;
        } else {
          //console.log('deltaObjStringified.length:', deltaObjStringified.length);
        }
      } else {
        //console.log('deltaObjStringified is null');
      }

      if (jsonp_endpoint) {
        assert (pyState !== '2' && pyState !== '3');
        // hack! should just be a dummy script for logging only
        $.get(backendScript,
              {user_script : codeToExec,
               options_json: JSON.stringify(backendOptionsObj),
               user_uuid: supports_html5_storage() ? localStorage.getItem('opt_uuid') : undefined,
               session_uuid: this.sessionUUID,
               diffs_json: deltaObjStringified},
               function(dat) {} /* don't do anything since this is a dummy call */, "text");

        // the REAL call uses JSONP
        // http://learn.jquery.com/ajax/working-with-jsonp/
        $.ajax({
          url: jsonp_endpoint,
          // The name of the callback parameter, as specified by the YQL service
          jsonp: "callback",
          dataType: "jsonp",
          data: {user_script : codeToExec,
                 options_json: JSON.stringify(backendOptionsObj)},
          success: execCallback.bind(this) /* tricky! */,
        });
      } else {
        // for Python 2 or 3, directly execute backendScript
        assert (pyState === '2' || pyState === '3');
        $.get(backendScript,
              {user_script : codeToExec,
               raw_input_json: this.rawInputLst.length > 0 ? JSON.stringify(this.rawInputLst) : '',
               options_json: JSON.stringify(backendOptionsObj),
               user_uuid: supports_html5_storage() ? localStorage.getItem('opt_uuid') : undefined,
               session_uuid: this.sessionUUID,
               diffs_json: deltaObjStringified},
               execCallback.bind(this) /* tricky! */, "json");
      }
  }

  setSurveyHTML() {
    $('#surveyPane').html(survey_v8);
  }
} // END class AbstractBaseFrontend


/* For survey questions. Versions of survey wording:

[see ../../v3/js/opt-frontend-common.js for older versions of survey wording - v1 to v7]

v8: (deployed on 2016-06-20) - like v7 except emphasize the main usage survey more, and have the over-60 survey as auxiliary
*/
const survey_v8 = '\n\
<p style="font-size: 10pt; margin-top: 10px; margin-bottom: 15px; line-height: 175%;">\n\
<span>Support our research and keep this tool free by <a href="https://docs.google.com/forms/d/1-aKilu0PECHZVRSIXHv8vJpEuKUO9uG3MrH864uX56U/viewform" target="_blank">filling out this user survey</a>.</span>\n\
<br/>\n\
<span style="font-size: 9pt;">If you are <b>at least 60 years old</b>, please also fill out <a href="https://docs.google.com/forms/d/1lrXsE04ghfX9wNzTVwm1Wc6gQ5I-B4uw91ACrbDhJs8/viewform" target="_blank">our survey about learning programming</a>.</span>\n\
</p>'


// misc utilities:

// From http://stackoverflow.com/a/8809472
export function generateUUID(){
    var d = new Date().getTime();
    var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = (d + Math.random()*16)%16 | 0;
        d = Math.floor(d/16);
        return (c=='x' ? r : (r&0x7|0x8)).toString(16);
    });
    return uuid;
};

// From http://diveintohtml5.info/storage.html
export function supports_html5_storage() {
  try {
    return 'localStorage' in window && window['localStorage'] !== null;
  } catch (e) {
    return false;
  }
}
