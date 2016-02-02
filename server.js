var TOKENS = require('./secret/tokens.js');
var instagram = require('instagram-node');
var api = instagram.instagram();


api.use({ client_id: TOKENS.insta.client_id,
         client_secret: TOKENS.insta.client_secret });

var read = require('fs').readFileSync;
var https = require('https');
var http = require('http');
var rp = require('request-promise');
var express = require('express');
var app = express();

var httpsOptions = {
        key: read('secret/private-key.pem', 'utf8'),
        cert: read('secret/classifi_me.crt', 'utf8'),
        ca: [
            read('secret/bundle1.pem', 'utf8'),
            read('secret/bundle2.pem', 'utf8')
        ]
    };

app.all('*', ensureSecure); // at top of routing calls

app.use('/', express.static('static'));

app.use('/go', express.static('go'));

var Clarifai = require('./clarifai_node.js');
Clarifai.initAPI(TOKENS.clarifai.client_id, TOKENS.clarifai.client_secret );

var redirect_uri = 'https://classifi.me/go';

exports.authorize_user = function(req, res) {
  // var user = "";
  // if(req.query.user){
  //   user = "?user=" + req.query.user;
  // }
  res.redirect(api.get_authorization_url(redirect_uri, {}));
};

exports.handleauth = function(req, res) {
  // var user = "";
  // if(req.query.user){
  //   user = "?user=" + req.query.user;
  // }
  api.authorize_user(req.query.code, redirect_uri, function(err, result) {
      if(err){
        console.log(err);
        res.json(err);
        return;
      }
      // console.log('Yay! Access token is ' + result.access_token);
      var insta = instagram.instagram();
      insta.use({ access_token: result.access_token });
      // console.log(JSON.stringify(result));

      var date = new Date();
      var options = {
	count: 100,
        max_timestamp: Date.now(),
        min_timestamp: new Date(new Date().setYear(new Date().getFullYear() + 1))
      }
      // var un = req.query.user ? req.query.user : result.user.id;

      /* OPTIONS: { [count], [min_timestamp], [max_timestamp], [min_id], [max_id] }; */
      insta.user_media_recent(result.user.id, options, function(err, medias, pagination, remaining, limit) {
	if(medias.length < 1){
	  res.redirect("http://static.squarespace.com/static/527a4320e4b0536ab6ec1dc5/529652d1e4b008c3d65eef19/529652e5e4b008c3d65f03f2/1376449828000/tumblr_mqfampbfRs1ql5yr7o1_500.gif?format=original");
	}
	console.log("Num of pics: " + medias.length + " pagination: " + JSON.stringify(pagination)); 
        var urlArr = medias.map(function(media){
          if(media['videos']){
            return media['videos']['standard_resolution']['url'];
          }else{
            return media['images']['standard_resolution']['url'];
          }
        });

        var maxHappiness = {"image_url": "", "probability": 0};
        var maxUpsetness = {"image_url": "", "probability": 0};

        var allPromises = [];
        urlArr.forEach(function(url) {
          allPromises.push(getTagsByURL(url));
        });

        Promise.all(allPromises)
        .then(function(r) {

          var morePromises = [];

          // console.log(r);

          for(var i = 0; i < r.length; i++) {
            var personality = [];
            // console.log(i);
            var theText = r[i].join(" ");

            // console.log(medias[i].caption);
            // console.log(medias[i].caption.text);

            if(medias[i].caption ) {
              theText += " " + trimTweet(medias[i].caption.text);
            }

            personality.push(getSensingIntuition(theText));
            personality.push(getThinkingFeeling(theText));
            personality.push(getExtraIntro(theText));
            personality.push(getJudgingPerceiving(theText));
            personality.push(getMood(theText));
            personality.push(getSentiment(theText));
            // console.log(theText);
            morePromises.push(Promise.all(personality));
          }

          // console.log("hello");

          Promise.all(morePromises).then(function(theBigArray) {
            // console.log("yo");
            // console.log(JSON.stringify(theBigArray));
            theBigArray = theBigArray.map(function(p){
              var display = {};
              p.forEach(function(obj){
                for(var attrname in obj) { display[attrname] = obj[attrname]; }
              });
              return display;
            });

            var happyIndex = 0;
            console.log("What was the happiest song\n" + JSON.stringify(theBigArray.reduce(function(previousValue, currentValue, currentIndex, array) {

              if(previousValue.happy >= currentValue.happy){
                return previousValue;
              }else{
                happyIndex = currentIndex;
                return currentValue;
              }
              return (previousValue.happy > currentValue.happy) ? previousValue:currentValue;
            })));

            // console.log("THIS IS THE HAPPY" + happyIndex);



            var sendThis = {
              medias:medias,
              emotions:theBigArray,
              happiest:happyIndex
            }
            res.json(sendThis);
            // api.use({ client_id: '9ba26a3c029f4d918f5619a8eaafd80c',
            //          client_secret: '345ef7f5f4e043a2bbc55f2fae13b39a' });
          });
        }).catch(function(error){
	  console.log(error);
	  res.redirect(req.get('referer'));
        });
      });
  });
};

function ensureSecure(req, res, next){
  if(req.secure){
    // OK, continue
    return next();
  };
  res.redirect('https://'+req.hostname+req.url); // handle port numbers if you need non defaults
};

// This is where you would initially send users to authorize
app.get('/authorize_user', exports.authorize_user);
// This is your redirect URI
app.get('/handleauth', exports.handleauth);
app.set('HTTPPort', 3000);
app.set('HTTPSPort',4000);
http.createServer(app).listen(app.get('HTTPPort'), function(){
  console.log("HTTP listening on port " + app.get('HTTPPort'));
});

https.createServer(httpsOptions,app).listen(app.get('HTTPSPort'), function(){
  console.log("HTTPS listening on port " + app.get('HTTPSPort'));
});

var getTagsByURL = function(url) {
  return new Promise(function(resolve, reject) {
    Clarifai.tagURL( url, null, "", function(error, response){
        //console.log(JSON.stringify(response));
        // console.log(JSON.stringify(response));
        if(error || !response){
	  error = error ? error : "no response";          
	  console.log(error);
          reject(error);
	  return;
        }
        var list = response.results[0].result.tag.classes;

        if(Array.isArray(list[0])) {
          var flattened = [];
          list.forEach(function(arr){
            flattened = flattened.concat(arr);
          });
          resolve(flattened);
        } else {
          resolve(list);
        }
    });
  });
};

var getSensingIntuition = function(text) {
  return new Promise(function(resolve, reject) {
    // console.log(text);
    rp('http://uclassify.com/browse/prfekt/myers-briggs-perceiving-function/ClassifyText?readkey='+TOKENS.uclassify.read_key+'&version=1.01&output=json&text='+text)
    .then(function (response) {
      if(typeof response == "string")
        response = JSON.parse(response);
        // Process html...
      // console.log(JSON.stringify(response.cls1));
      resolve({ "sensing": response.cls1.Sensing, "intuition": response.cls1.iNtuition });
    })
    .catch(function (err) {
        // Crawling failed...
        console.log(err);
        reject(err);
    });
  });
};

var getThinkingFeeling = function(text) {
  return new Promise(function(resolve, reject) {
    // console.log(text);
    rp('http://uclassify.com/browse/prfekt/myers-briggs-judging-function/ClassifyText?readkey='+TOKENS.uclassify.read_key+'&version=1.01&output=json&text='+text)
    .then(function (response) {
      if(typeof response == "string")
        response = JSON.parse(response);
        // Process html...
      // console.log(JSON.stringify(response.cls1));
      resolve({ "feeling": response.cls1.Feeling, "thinking": response.cls1.Thinking });
    })
    .catch(function (err) {
        // Crawling failed...
        console.log(err);
        reject(err);
    });
  });
};

var getExtraIntro = function(text) {
  return new Promise(function(resolve, reject) {
    // console.log(text);
    rp('http://uclassify.com/browse/prfekt/myers-briggs-attitude/ClassifyText?readkey='+TOKENS.uclassify.read_key+'&version=1.01&output=json&text='+text)
    .then(function (response) {
      if(typeof response == "string")
        response = JSON.parse(response);
        // Process html...
      // console.log(JSON.stringify(response.cls1));
      resolve({ "extraversion": response.cls1.Extraversion, "introversion": response.cls1.Introversion });
    })
    .catch(function (err) {
        // Crawling failed...
        console.log(err);
        reject(err);
    });
  });
};

var getJudgingPerceiving = function(text) {
  return new Promise(function(resolve, reject) {
    // console.log(text);
    rp('http://uclassify.com/browse/prfekt/myers-briggs-lifestyle/ClassifyText?readkey='+TOKENS.uclassify.read_key+'&version=1.01&output=json&text='+text)
    .then(function (response) {
      if(typeof response == "string")
        response = JSON.parse(response);
        // Process html...
      // console.log(JSON.stringify(response.cls1));
      resolve({ "judging": response.cls1.Judging, "perceiving": response.cls1.Perceiving });
    })
    .catch(function (err) {
        // Crawling failed...
        console.log(err);
        reject(err);
    });
  });
};

var getMood = function(text) {
  return new Promise(function(resolve, reject) {
    // console.log(text);
    rp('http://uclassify.com/browse/prfekt/mood/ClassifyText?readkey='+TOKENS.uclassify.read_key+'&version=1.01&output=json&text='+text)
    .then(function (response) {
      if(typeof response == "string")
        response = JSON.parse(response);
        // Process html...
      // console.log(JSON.stringify(response.cls1));
      resolve({ "happy": response.cls1.happy, "upset": response.cls1.upset });
    })
    .catch(function (err) {
        // Crawling failed...
        console.log(err);
        reject(err);
    });
  });
};

var getSentiment = function(text) {
  return new Promise(function(resolve, reject) {
    // console.log(text);
    rp('http://uclassify.com/browse/uclassify/sentiment/ClassifyText?readkey='+TOKENS.uclassify.read_key+'&version=1.01&output=json&text='+text)
    .then(function (response) {
      if(typeof response == "string")
        response = JSON.parse(response);
        // Process html...
      // console.log(JSON.stringify(response.cls1));
      resolve({ "negative": response.cls1.negative, "positive": response.cls1.positive });
    })
    .catch(function (err) {
        // Crawling failed...
        console.log(err);
        reject(err);
    });
  });
};

function trimTweet(text){

  //remove links
  // var noLinks = /[-a-zA-Z0-9@:%_\+.~#?&//=]{2,256}\.[a-z]{2,4}\b(\/[-a-zA-Z0-9@:%_\+.~#?&//=]*)?/gi;
  // text = text.replace(noLinks, "");

  //remove non alphanumeric chars
  text = text.replace(/[\W_!.]/g, ' ');

  //remove extra whitespace
  // text = text.replace(/\s\s+/g, ' ');
  return text;
}

function max(search){
  var happyIndex = 0;
  console.log("What was the " + search + "iest picutr\n" + JSON.stringify(theBigArray.reduce(function(previousValue, currentValue, currentIndex, array) {

    if(previousValue[searh] >= currentValue[searh]){
      return previousValue;
    }else{
      happyIndex = currentIndex;
      return currentValue;
    }
    return (previousValue.happy > currentValue.happy) ? previousValue:currentValue;
  })));

  // console.log("THIS IS THE "  + happyIndex);
}
