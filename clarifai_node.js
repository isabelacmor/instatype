// clarifai_node.js - the Clarifai client API for node.js programs
//
// this version supports:
//   tagging by single URL
//   tagging by multiple URLs
//   giving feedback to add tags to multiple docids
//   giving feedback to remove tags from multiple docids
//   automatically requesting a new access token, and queuing any requests received while the access token request is in flight
//   honoring the server throttling instructions   
//
// to get an idea of how to use the API, see the example clarifai_sample.js in the same directory
// requires only that you have node installed

var querystring = require('querystring');
var https = require('https');
var http = require('http');

var tagPath = "/v1/tag/";
var requestTokenPath = "/v1/token";
var feedbackPath = "/v1/feedback";


/* handle the common responses to HTTP status codes
 * 200 and 401 Unauthorized are passed to the httpSuccessHandler
 * 429 throttles the client
 * @param res the HttpResponse object
 * @param responseData the data body of the response
 * @param localId the local id provided by the client with the request that generated this response
 * @param resultHandler the method that will be called if this client isn't going to handle it (e.g. invalid tokens or throttled responses)
 * @param retry a closure that will be queued for retry in case we are throttled and are queueing
 */ 
Clarifai.prototype._commonHttpStatusHandler = function(  res, responseData, localId, resultHandler, retry ) {

	if( this._bLogHttp ) console.log( "HTTP response statusCode: "+res.statusCode);
	if( this._bLogHttp ) console.log( "HTTP response data: "+responseData );

	http_status = res.statusCode;
	switch( http_status ) {
		case 200: // returned by tag method
		case 201: // returned by feedback methods

			res = JSON.parse(responseData);
			switch( res["status_code"] ) {
				case "OK":
				case "PARTIAL_ERROR": // return as *success* because there is *some* success
					if( this._bLogResults ) console.log( res );
					resultHandler( null, res );
					break;
				default:
					if(this._bVerbose) console.log( "_commonApiStatusHandler: unhandled API response: "+res["status_code"]);
					break;
			}


			break;

		case 401: // unauthorized. API host returns this when CLIENT_ID / CLIENT_SECRET are not valid/authorized.
			// both TOKEN_INVALID and TOKEN_APP_INVALID are returned with 401
			// need to distinguish

			res = JSON.parse(responseData);
			if( typeof res["status_code"] === "string" && res["status_code"] === "TOKEN_INVALID") {
				if(this._bVerbose) console.log("Server refused request due to invalid Access Token");
				this._requestAccessToken( retry, resultHandler );
				break;
			}
			else {
				resultHandler( JSON.parse( responseData), null ); 
			}

			break;

		case 429:
			waitSeconds = res.headers["x-throttle-wait-seconds"];
			if(this._bVerbose) console.log('Server throttled. Wait time: '+waitSeconds+' seconds.');
			if( ! this._throttled ) {
				this._throttled = true;
				if( typeof( this._handleThrottleChanges ) == "function" ) {
					this._handleThrottleChanges( true, waitSeconds );	
					// only set a timeout handler to call the throttle change handler if
					// there is one registered. No reason waiting on the timeout otherwise.
					this._throttleTimeout = setTimeout( function() { 
						this._throttled = false;
						if(typeof( this._handleThrottleChanges ) == "function" ) this._handleThrottleChanges( false, 0 ); }.bind(this), 
						1000*Number(waitSeconds) );
				} 
				
			}
			resultHandler( JSON.parse( responseData ), null );

			break;

		case 400: // ALL_ERROR - All images in the request had errors 

			resultHandler( JSON.parse( responseData ), null );
			break;

		case 500: // Internal Server Error

			// the API Host uses this for catastrophic failures e.g. no vision backends are available
			resultHandler( JSON.parse( responseData ), null );
			break;

		default:
			if(this._bVerbose) {
				console.log( "unexpected http status code "+http_status);
				console.log( responseData );
			}
			resultHandler( JSON.parse( responseData ), null );
			break;
	}
}


// handling the response to access token requests is a bit different than handling ordinary
// http requests for the other API methods. if successful, we:
// save the new access token 
// set the request-in-flight flag to false
// despool any requests that queued while waiting for new access token
// in addition to handling errors in the response to the access token request,
// we have to handle the cases where the request or response is lost
Clarifai.prototype._tokenResponseHandler = function( res, responseData, resultHandler ) {

	if( this._bLogHttp ) console.log( "HTTP response statusCode: "+res.statusCode);
	if( this._bLogHttp ) console.log( "HTTP response data: "+responseData );

	http_status = res.statusCode;
	switch( http_status ) {
		case 200: // for the access token request, we only treat 200 as success
			parsedResponse = null;
			try {
				parsedResponse = JSON.parse(responseData);
			}
			catch( ex ) {
				console.error("Clarifai API host returned a non-JSON response body. Please contact Clarifai support.");
				console.error( responseData );
				// what now?
				return;
			}
			if( parsedResponse["status_code"]) {
				if(this._bVerbose) console.log("Access Token HTTP Response: API status_code="+parsedResponse["status_code"]);
			}
			if( typeof parsedResponse["access_token"] === "string") {
				this._accessToken = parsedResponse["access_token"];
				// if the response is well-formed and we got a new token, then clear
				// the in-flight flag
				this._tokenRequestInFlight = false;
				this._tokenRetries = 0;
				// despool the queued requests if any
				while( 0 < this._retryQueue.length ) {
					tuple = this._retryQueue.pop();
					r = tuple[0];
					r();
				}	
			}
			break;
		case 401: 
			// the API host returns 401 and status_code="TOKEN_APP_INVALID" when the client_id and secret are bad
		case 500:
			// the API host returns 500 for internal server errors 
			// these are both fatal when we need a new access token, and the client code needs to get this error response
			// despool queued [ retry, resultHandler ] and call handlers with fatal error
			this._tokenRequestInFlight = false;
			this._tokenRetries = 0;
			// despool the queued requests if any
			while( 0 < this._retryQueue.length ) {
				tuple = this._retryQueue.pop();
				rh = tuple[1];
				rh( responseData, null );
			}	
			break;
		default:
			if(this._bVerbose) console.log( "Access Token HTTP Response: unexpected http status code "+http_status);
			break;
	}
}


// request a new access token
// the retry parameter is a bound function that will be retried once a new access token
// has been received.
// the resultHandler is the client resultHandler passed to the orginal Api method. it will
// be called with a fatal error if we fail to get a new access token
Clarifai.prototype._requestAccessToken  = function(  retry , resultHandler ) {
	// the original call from an API request will include a retry bound function and the client
	// resultHandler callback. retry calls from tokenResponseHandler will not.

	if( retry != null ) {
		this._retryQueue.push( [ retry, resultHandler ] );
		if (this._tokenRequestInFlight) {
			if(this._bVerbose) console.log( "Access Token request already in flight. Queuing request for completion with fresh token.");
			return;
		}
		this._tokenRequestInFlight = true;
		if(this._bVerbose) console.log( "Requesting new Access Token. Queuing request for completion with fresh token.");
	}

	var responseData = '';
	var form = new Array();
	form["grant_type"]="client_credentials";
	form["client_id"] = this._clientId;
	form["client_secret"] = this._clientSecret;
	var formData = querystring.stringify( form );

	this.POSTheaders["Content-Length"] = formData.length;
	this.POSTheaders["Authorization"] = "Bearer "+this._accessToken;

	var self = this;
	var req = https.request( {
		headers : this.POSTheaders,
		hostname :  this._apiHost,
		port : this._apiPort,
		path : requestTokenPath,
		method: 'POST'
	}, function(res) {
		res.setEncoding('utf8');
		res.on("error",console.error);
		res.on("data",function(chunk) { responseData += chunk; } );
		res.on("end", function() { self._tokenResponseHandler(res, responseData); } );
	}).on("error",function( err ) { 
		if( self._tokenRetries >= self._tokenMaxRetries ) {
			// despool queued [ retry, resultHandler ] and call handlers with fatal error
			this._tokenRequestInFlight = false;
			this._tokenRetries = 0;
			// despool the queued requests if any
			while( 0 < self._retryQueue.length ) {
				tuple = self._retryQueue.pop();
				rh = tuple[1];
				rh( {"status_code": "TOKEN_FAILURE", "status_msg": "Failed to get access token. Contact Clarifai support." }, null );
			}	
		}
		else {
			self._tokenRetries++;
			if( self._bVerbose ) console.log("retrying access token request "+self._tokenRetries);
			self._requestAccessToken( null, null );
		}
	});


	req.on("socket", function(socket) {
		socket.setTimeout( self._tokenRequestWait_ms );
		socket.on("timeout", function() { 
			// aborting the request due to timeout causes the request on error handler to be
			// called with { [Error: socket hang up] code: 'ECONNRESET' }. That will be passed
			// to the client resultHandler callback as the err parameter
			req.abort();
		});
	} );	

	req.write( formData );
	if( this._bLogHttp ) console.log(req.output);
	req.end();

}

Clarifai.prototype._httpRequest = function( endpoint, form, localId, resultHandler, retry  )
{
	var responseData = '';

	if( localId != null ) form["local_id"] = localId;
	if( this._model != null ) form["model"] = this._model;

	var formData = querystring.stringify( form );

	this.POSTheaders["Content-Length"] = formData.length;
	this.POSTheaders["Authorization"] = "Bearer "+this._accessToken;

	var self = this;
	var req = https.request( {
		headers : self.POSTheaders,
		hostname :  self._apiHost,
		port : self._apiPort,
		path : endpoint,
		rejectUnauthorized : false,
		method: 'POST'
	}, function(res) {
		res.setEncoding('utf8');
		res.on("error",function( err ) { console.log("res http error: "); console.log(err); } );
		res.on("data",function(chunk) { responseData += chunk; } );
		res.on("end",function() { 
			self._commonHttpStatusHandler( res, responseData, localId, resultHandler, retry );
			});

	}).on("error",function( err ) { 

		if( typeof err["code"] === "string" && err["code"] === "ECONNRESET")
			err =  {"status_code": "TIMEOUT", "status_msg": "Response not received" };

		resultHandler( err, null ); 

	});

	req.on("socket", function(socket) {
		socket.setTimeout(self._requestTimeout_ms);
		socket.on("timeout", function() { 
			// aborting the request due to timeout causes the request on error handler to be
			// called with { [Error: socket hang up] code: 'ECONNRESET' }. That will be passed
			// to the client resultHandler callback as the err parameter
			req.abort();
		});
	} );	

	req.write( formData );
	if( this._bLogHttp ) console.log(req.output);
	req.end();
}

// internal method to invoke TAG API endpoint.
// url is a reference to an image accessible from the API host
// localId is the client id for the image referenced by url
// resultHandler(err, success) is the client callback called when the request completes or timesout
// retry is a bound function that can replicate the client's original call. this is used
// when/if we temporarily queue requests when the access token is invalid and
// a new one is being requested
Clarifai.prototype._tagURL  = function( url, classes, localId, resultHandler, retry ) {
	if( this._throttled ) 
		// the host has throttled us, so there's no point in sending the request
		// just immediately return the throttled status
		resultHandler( { 'status_code': 'ERROR_THROTTLED',
				    'status_msg': 'Request refused. Service is throttled.'} , null );

	// var responseData = '';

	// handle both a single url string and a list of url strings
	if( typeof url == "string" ) url = [ url ];
	var form = new Array();
	form["url"] = url;
	if(classes){
		form["select_classes"] = classes.join(',');
	}
	this._httpRequest( tagPath, form, localId, resultHandler, retry );

}

Clarifai.prototype.tagURL = function( url, classes, localId, callback ) {

  retry = function() {
      this.tagURL( url, classes, localId, callback );
  }.bind(this);

  this._tagURL( url, classes, localId,
    callback,	
    retry );

}

// _feedbackTagsDocids is a private method for adding or removing
// tags from a list of docids. Whether to add or remove is specified by the
// boolean bAdd.
Clarifai.prototype._feedbackTagsDocids = function( docids, tags, localId, bAdd, resultHandler, retry ) {

	if( this._throttled ) 
		// the host has throttled us, so there's no point in sending the request
		// just immediately return the throttled status
		resultHandler( { 'status_code': 'ERROR_THROTTLED',
				    'status_msg': 'Request refused. Service is throttled.'} , null );


	var responseData = '';
	var form = new Array();
	form["docids"] = docids;
	form[bAdd ? "add_tags" : "remove_tags"] = tags;

	this._httpRequest( feedbackPath, form, localId, resultHandler, retry );

}

Clarifai.prototype.feedbackAddTagsToDocids = function( docids, tags, localId, callback ) {

	this._feedbackTagsDocids( docids, tags, localId, true, callback, function() { this.feedbackAddTagsToDocids( docids, tags, localId, callback ); }.bind(this) );

}

Clarifai.prototype.feedbackRemoveTagsFromDocids = function( docids, tags, localId, callback ) {

	this._feedbackTagsDocids( docids, tags, localId, true, callback, function() { this.feedbackAddTagsToDocids( docids, tags, localId, callback ); }.bind(this) );

}

Clarifai.prototype.setThrottleHandler = function( newThrottleHandler ) {
	this._handleThrottleChanges = newThrottleHandler;
}

Clarifai.prototype.clearThrottleHandler = function(  ) {
	clearTimeout( this._throttleTimeout ); 
	this._handleThrottleChanges = null;;
}

// set the global request timeout duration to newTimeout_ms (in milliseconds)
// the default value is 3000 (3 seconds)
Clarifai.prototype.setRequestTimeout = function( newTimeout_ms ) {
	this._requestTimeout_ms = newTimeout_ms;
	if( this._bVerbose) console.log( "new timeout "+this._requestTimeout_ms);
}

Clarifai.prototype.setHost = function( newHost ) {
	this._apiHost = newHost;
}

Clarifai.prototype.setPort = function( newPort ) {
	this._apiPort = newPort;
}

Clarifai.prototype.setModel = function( newModel ) {
	this._model = newModel;
}

Clarifai.prototype.setLogHttp = function( bLog ) {
	this._bLogHttp = bLog;
}

Clarifai.prototype.setVerbose = function( bVerbose ) {
	this._bVerbose = bVerbose;
}

Clarifai.prototype.initAPI = function( clientId, clientSecret ) {
	this._clientId = clientId;
	this._clientSecret = clientSecret;	
}

function Clarifai( ) {
	this._clientId = "";
	this._clientSecret = "";
	this._apiHost = "api.clarifai.com";
	this._apiPort = "443";
	this._http = http;
	this._model = null;
	this._accessToken = "uninitialized";

	this._tokenRetries = 0;
	this._tokenMaxRetries = 2;
	this._requestTimeout_ms = 3*1000;
	this._tokenRequestInFlight = false;
	this._tokenRequestTimeout = null;
	this._tokenRequestWait_ms = 3*1000; 
	this._tokenRequestRetryAttempts = 0;
	this._maxTokenRequestAttempts = 3;          // if we can't get a good token after 3 attempts, things are grim
	this._retryQueue = [];
	this._throttled = false;
	this._handleThrottleChanges = null;
	this._throttleTimeout = null;
	this._bLogHttp = false;
	this._bVerbose = false;

	this.POSTheaders = {
		"Content-Length" : 0,
		"Content-Type" : "application/x-www-form-urlencoded",
	};

}

module.exports = exports = new Clarifai();
