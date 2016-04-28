'use strict';
const CONFIG = require('./config');
const PORT = 8445;
const request = require('request');
const express = require('express');
const Wit = require('node-wit').Wit;
const bodyParser = require('body-parser');
const vision = require('node-cloud-vision-api');
const foursquare = (require('foursquarevenues'))(CONFIG.FSQ_KEY, CONFIG.FSQ_SECRET);

const fbReq = request.defaults({
  uri: 'https://graph.facebook.com/me/messages',
  method: 'POST',
  json: true,
  qs: { access_token: CONFIG.FB_PAGE_TOKEN },
  headers: {'Content-Type': 'application/json'},
});

const fbMessage = (recipientId, msg, cb) => {
  const opts = {
    form: {
      recipient: {
        id: recipientId,
      },
      message: {
        text: msg,
      },
    },
  };
  fbReq(opts, (err, resp, data) => {
    if (cb) {
      cb(err || data.error && data.error.message, data);
    }
  });
};

const getFirstMessagingEntry = (body) => {  
  const val = body.object == 'page' &&
    body.entry &&
    Array.isArray(body.entry) &&
    body.entry.length > 0 &&
    body.entry[0] &&
    body.entry[0].id == CONFIG.FB_PAGE_ID &&
    body.entry[0].messaging &&
    Array.isArray(body.entry[0].messaging) &&
    body.entry[0].messaging.length > 0 &&
    body.entry[0].messaging[0]
  ;
  return val || null;
};


// Wit.ai bot specific code
// sessionId -> {fbid: facebookUserId, context: sessionState}
const sessions = {};

const findOrCreateSession = (fbid) => {
  let sessionId;
  Object.keys(sessions).forEach(k => {
    if (sessions[k].fbid === fbid) {
      sessionId = k;
    }
  });
  if (!sessionId) {
    sessionId = new Date().toISOString();
    sessions[sessionId] = {fbid: fbid, context: {}};
  }
  return sessionId;
};

const firstEntityValue = (entities, entity) => {
  const val = entities && entities[entity] &&
    Array.isArray(entities[entity]) &&
    entities[entity].length > 0 &&
    entities[entity][0].value
  ;
  if (!val) {
    return null;
  }
  return typeof val === 'object' ? val.value : val;
};

const actions = {
  say(sessionId, context, msg, cb) {
    const recipientId = sessions[sessionId].fbid;
    if (recipientId) {
      fbMessage(recipientId, msg, (err, data) => {
        if (err) {
          console.log(
            'Oops! An error occurred while forwarding the response to',
            recipientId,
            ':',
            err
          );
        }
        cb();
      });
    } else {
      console.log('Oops! Couldn\'t find user for session:', sessionId);
      cb();
    }
  },
  merge(sessionId, context, entities, message, cb) {
    const loc = firstEntityValue(entities, 'location');
    const q = firstEntityValue(entities, 'local_search_query');
    if (loc) {
      context.loc = loc;
      context.q = q;
    }
    cb(context);
  },
  error(sessionid, context, msg) {
    console.log('Oops, I don\'t know what to do.');
  },
  ['findPlace'](sessionId, context, cb) {
      var params = {
        'near': context.loc,
        'query': context.q
      };
     
      foursquare.getVenues(params, function(error, venues) {
        if (!error) {     
          if (venues['response'] && venues['response']['venues'].length > 0) {
            var result = venues['response']['venues'][0];
            var location = result['location'];
            context.place = result['name'];          
            context.address = location['address'] + ", " + location['crossStreet'] + ", " + 
                            location['city'] + ", " + location['state'];
            
            cb(context);      

          } else {
            cb();c
          }
        } else {
          cb();
        }
      });    
    
  },  
};

const app = express();
app.set('port', PORT);
app.listen(app.get('port'));
app.use(bodyParser.json());
const wit = new Wit(CONFIG.WIT_TOKEN, actions);
vision.init({auth: CONFIG.CLOUD_VISION_API_KEY})

app.get('/fb', (req, res) => {
  if (!CONFIG.FB_VERIFY_TOKEN) {
    throw new Error('missing FB_VERIFY_TOKEN');
  }
  if (req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === CONFIG.FB_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});

app.post('/fb', (req, res) => {    
  const messaging = getFirstMessagingEntry(req.body);
  

  if (messaging && messaging.message && messaging.recipient.id == CONFIG.FB_PAGE_ID) {    
    console.log("Got a new message");
    const sender = messaging.sender.id;
    const sessionId = findOrCreateSession(sender);

    const msg = messaging.message.text;
    const atts = messaging.message.attachments;

    if (atts) {
      const attachment = atts[0]
      if (attachment.type == 'image') {
        console.log("analyzing " + attachment.payload.url);

        const analyzingMsg = "Got it, you sent me a picture, give me a minute to analyze it";
        fbMessage(
            sender,
            analyzingMsg
        );
        const req = new vision.Request({
          image: new vision.Image({
            url: attachment.payload.url
          }),
          features: [
            new vision.Feature('FACE_DETECTION', 4),
            new vision.Feature('LABEL_DETECTION', 10),
          ]
        });

        vision.annotate(req).then((res) => {
          const firsResponse = res.responses[0];
          const faceResponses = firsResponse.faceAnnotations;
          const labelResponses = firsResponse.labelAnnotations;
          
          var labelsDescriptions = [];
          var facesCharacteristics = [];
          const characteristicsToDetect = ["joyLikelihood", "sorrowLikelihood", "angerLikelihood", "surpriseLikelihood", "underExposedLikelihood", "blurredLikelihood", "headwearLikelihood"];
          var face = 1;
          if (faceResponses) {    
            faceResponses.forEach(function (value) {
              if (value.detectionConfidence > 0.4) {      
                var possible = [];
                var veryLikely = [];
                
                characteristicsToDetect.forEach(function (emValue) {
                  if (value[emValue] == "VERY_LIKELY") {                  
                    veryLikely.push(emValue.substring(0, emValue.indexOf("Likelihood")));          
                  }

                  if (value[emValue] == "POSSIBLE") {                  
                    possible.push(emValue.substring(0, emValue.indexOf("Likelihood")));          
                  }                                    
                });

                if (veryLikely.length > 0) {
                  facesCharacteristics.push(ordinalSuffixOf(face) + " face is very likely to show " + veryLikely);  
                }

                if (possible.length > 0) {
                  facesCharacteristics.push(ordinalSuffixOf(face) + " face is possible to show " + possible);  
                }                
              }
              face++;     
            });
          } 

          if (labelResponses) {  
            labelResponses.forEach(function (value) {
              if (labelsDescriptions.indexOf(value.description) === -1) {
                labelsDescriptions.push(value.description);
              }             
          });
          }

          var labels = "Picture may include " + labelsDescriptions.toString();              
          if (labelsDescriptions.length > 0) {
            fbMessage(
              sender,
              labels
            );            
          }

          if (facesCharacteristics.length > 0) {
            var faces = "I identified " + faceResponses.length + " faces. " + facesCharacteristics.toString();
            fbMessage(
              sender,
              faces
            );

          }


        }, (e) => {
          console.log('Error: ', e)
        })
      }
                  
    } else if (msg) {
      wit.runActions(
        sessionId,
        msg, 
        sessions[sessionId].context, 
        (error, context) => {
          if (error) {
            console.log('Oops! Got an error from Wit:', error);
          } else {
            console.log('Waiting for futher messages.');
            sessions[sessionId].context = context;
          }
        }
      );
    }
  }
  res.sendStatus(200);
});

function ordinalSuffixOf(i) {
    const j = i % 10,
          k = i % 100;
    if (j == 1 && k != 11) {
        return i + "st";
    }
    if (j == 2 && k != 12) {
        return i + "nd";
    }
    if (j == 3 && k != 13) {
        return i + "rd";
    }
    return i + "th";
}

console.log("Ready!");