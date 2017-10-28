/* eslint-disable  func-names */
/* eslint quote-props: ["error", "consistent"]*/

'use strict';

const Alexa = require('alexa-sdk');
const https = require('https');

const APP_ID = process.env.app_id;
let token;

let userLocation, foodType, priceRange;

function buildPath(location, foodType, priceRange) {
    const term = 'restaurant';
    const encodedLocation = encodeURIComponent(location);
    let url = `/v3/businesses/search?term=${term}&location=${encodedLocation}&open_now&price=${priceRange}`;
    if(foodType)
        url += `&categories=${foodType}`;
    return url;
}

function buildSpeechOutput(restaurant) {
    const category = restaurant.categories[0].title;
    const distance = (restaurant.distance * 0.000621371).toFixed(1); // miles
    const name = sanitize(restaurant.name);

    const response = `${name} is ${distance} miles away if you're in the mood for ${category}...
        Check the Alexa app for more information`;

    console.log(response);
    return response;
}

function buildCard(restaurant) {
    const address = restaurant.location.display_address.join('\n');
    const phone = restaurant.phone;
    const url = restaurant.url;
    const content = `${address}\nNearby restaurant search provided by Yelp.`;
    return {
        title: restaurant.name,
        content: content,
        image: null /*{
            smallImageUrl: restaurant.image_url,
            largeImageUrl: restaurant.image_url
        }*/
    };
}

function sanitize(str) {
    return str.replace('&', 'and');
}

// sets the global foodtype and pricerange slots from event.
function setSlots(event) {
    let ft = [];
    try {
        let values = event.request.intent.slots.foodtype.resolutions.resolutionsPerAuthority[0].values;
        for(let v of values){
            ft.push(v.value.id);
        }

        foodType = ft.join(',');
    }
    catch(e) {
        if(!e instanceof TypeError){
            throw e;
        } 
        foodType = null;
    }

    let pr;
    try {
        pr = event.request.intent.slots.price.resolutions.resolutionsPerAuthority[0].values[0].value.id;
    }
    catch(e) {
        if(!e instanceof TypeError){
            throw e;
        } 
        pr = null;
    }

    switch (pr) {
        case 'cheap':
            priceRange = '1,2';
            break;
        case 'mid':
            priceRange = '2,3';
            break;
        case 'expensive':
            priceRange = '3,4';
            break;
        default:
            priceRange = '1,2,3,4';
            break;
    }
}

const responses = {
    SKILL_NAME: 'Random Restaurant',
    GET_RESTAURANT_MESSAGE: "Try out ",
    HELP_MESSAGE: 'You can say find a random restaurant, or, cancel... What can I help you with?',
    HELP_REPROMPT: 'What can I help you with?',
    STOP_MESSAGE: 'Goodbye!',
    YELP_ATTRIBUTION: ' ... Nearby restaurants provided by Yelp',
    NOTIFY_MISSING_PERMISSIONS: 'Please enable Location permissions in the Amazon Alexa app.',
    NO_ADDRESS: "It looks like you don't have an address set. You can set your address from the companion app.",
    ERROR: "Uh Oh. Looks like something went wrong."
};

const PERMISSIONS = [`read::alexa:device:all:address`];

const handlers = {
    'LaunchRequest': function () {
        this.emit('restaurant');
    },
    'restaurant': function () {
        this.emit('GetAddress');
    },
    'GetLocationPermission': function () {
        const speech = `Random Restaurant doesn't have permission to access your location. You can change permissions in the Alexa app.`;
        this.emit(':tell', speech);
    },
    'GetRestaurant': function () {
        this.emit('GetToken');
    },
    'GetToken': function () {
        const data = `client_id=${process.env.client_id}&client_secret=${process.env.client_secret}&grant_type=client_credentials`;
        const options = {
            host: 'api.yelp.com',
            port: 443,
            path: '/oauth2/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        const _this = this;
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (d) => {
                body += d;
            });
            res.on('end', function () {
                token = JSON.parse(body).access_token;
                _this.emit('GetRestaurantList');
            });
        });
        req.on('error', (e) => {
            console.error(e);
        });
        req.write(data);
        req.end();
    },
    'GetRestaurantList': function () {
        setSlots(this.event);
        console.log(foodType, priceRange);
        const options = {
            host: 'api.yelp.com',
            port: 443,
            path: buildPath(userLocation, foodType, priceRange),
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + token
            }
        };

        const _this = this;
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (d) => {
                body += d;
            });
            res.on('end', () => {
                let parsedData = JSON.parse(body);
                _this.emit('SendResponse', parsedData.businesses);
            });
        });
        req.on('error', (e) => {
            console.error(e);
        });
        req.end();

    },
    'SendResponse': function (restaurantArr) {
        if (restaurantArr.length === 0) {
            this.emit('NoRestaurants');
            return;
        }
        const randIndex = Math.floor(Math.random() * restaurantArr.length);
        const randRest = restaurantArr[randIndex];

        // Create speech output
        const speech = buildSpeechOutput(randRest);
        const card = buildCard(randRest);

        this.emit(':tellWithCard', speech, card.title, card.content, card.image);
    },
    'NoRestaurants': function () {
        const speech = 'No open restaurants found in your area. Make sure your address is up to date in the Alexa app and try again.';
        this.emit(':tell', speech);
    },
    'AMAZON.HelpIntent': function () {
        const speechOutput = responses.HELP_MESSAGE;
        const reprompt = responses.HELP_MESSAGE;
        this.emit(':ask', speechOutput, reprompt);
    },
    'AMAZON.CancelIntent': function () {
        this.emit(':tell', responses.STOP_MESSAGE);
    },
    'AMAZON.StopIntent': function () {
        this.emit(':tell', responses.STOP_MESSAGE);
    },
    'Unhandled': function (event) {
        console.log(event);
        this.emit(':tell', responses.ERROR);
    },
    'GetAddress': function () {
        console.info("Starting getAddressHandler()");

        // If we have not been provided with a consent token, this means that the user has not
        // authorized your skill to access this information. In this case, you should prompt them
        // that you don't have permissions to retrieve their address.
        if (!(this.event && this.event.context && this.event.context.System &&
            this.event.context.System.user && this.event.context.System.user.permissions
            && this.event.context.System.user.permissions.consentToken)) {

            this.emit(":tellWithPermissionCard", responses.NOTIFY_MISSING_PERMISSIONS, PERMISSIONS);

            // Lets terminate early since we can't do anything else.
            console.log("User did not give us permissions to access their address.");
            console.info("Ending getAddressHandler()");
            return;
        }
        const consentToken = this.event.context.System.user.permissions.consentToken;
        const deviceId = this.event.context.System.device.deviceId;
        const apiEndpoint = this.event.context.System.apiEndpoint;

        const alexaDeviceAddressClient = new AlexaDeviceAddressClient(apiEndpoint, deviceId, consentToken);
        let deviceAddressRequest = alexaDeviceAddressClient.getFullAddress();

        deviceAddressRequest.then((addressResponse) => {
            switch (addressResponse.statusCode) {
                case 200:
                    console.log("Address successfully retrieved, now responding to user.");
                    console.log(addressResponse)
                    let address = '';
                    for (let prop in addressResponse.address) {
                        if (addressResponse.address[prop] !== null) {
                            address += addressResponse.address[prop] + ' ';
                        }
                    }
                    userLocation = address;
                    console.log(userLocation)
                    this.emit("GetRestaurant");
                    break;
                case 204:
                    // This likely means that the user didn't have their address set via the companion app.
                    console.log("Successfully requested from the device address API, but no address was returned.");
                    this.emit(":tell", responses.NO_ADDRESS);
                    break;
                case 403:
                    console.log("The consent token we had wasn't authorized to access the user's address.");
                    this.emit(":tellWithPermissionCard", responses.NOTIFY_MISSING_PERMISSIONS, PERMISSIONS);
                    break;
                default:
                    this.emit(":ask", responses.LOCATION_FAILURE, responses.LOCATION_FAILURE);
            }

            console.info("Ending getAddressHandler()");
        });

        deviceAddressRequest.catch((error) => {
            this.emit(":tell", responses.ERROR);
            console.error(error);
            console.info("Ending getAddressHandler()");
        });
    },
    // SDK is broken. This is here until it is fixed.
    ':tellWithPermissionCard': function (speechOutput, permissions) {
        this.handler.response = buildSpeechletResponse({
            sessionAttributes: this.attributes,
            output: getSSMLResponse(speechOutput),
            permissions: permissions,
            type: 'AskForPermissionsConsent',
            shouldEndSession: true
        });
        this.emit(':responseReady');
    }
};

exports.handler = function (event, context) {
    const alexa = Alexa.handler(event, context);
    alexa.APP_ID = APP_ID;
    alexa.registerHandlers(handlers);
    alexa.execute();
};

// Also here to support the fix for the broken sdk.
function getSSMLResponse(message) {
    if (message == null) {
        return null;
    } else {
        return {
            type: 'SSML',
            speech: `<speak> ${message} </speak>`
        };
    }
}
function createSpeechObject(optionsParam) {
    if (optionsParam && optionsParam.type === 'SSML') {
        return {
            type: optionsParam.type,
            ssml: optionsParam['speech']
        };
    } else {
        return {
            type: optionsParam.type || 'PlainText',
            text: optionsParam['speech'] || optionsParam
        };
    }
}
function buildSpeechletResponse(options) {
    var alexaResponse = {
        shouldEndSession: options.shouldEndSession
    };

    if (options.output) {
        alexaResponse.outputSpeech = createSpeechObject(options.output);
    }

    if (options.reprompt) {
        alexaResponse.reprompt = {
            outputSpeech: createSpeechObject(options.reprompt)
        };
    }

    if (options.directives) {
        alexaResponse.directives = options.directives;
    }

    if (options.cardTitle && options.cardContent) {
        alexaResponse.card = {
            type: 'Simple',
            title: options.cardTitle,
            content: options.cardContent
        };

        if (options.cardImage && (options.cardImage.smallImageUrl || options.cardImage.largeImageUrl)) {
            alexaResponse.card.type = 'Standard';
            alexaResponse.card['image'] = {};

            delete alexaResponse.card.content;
            alexaResponse.card.text = options.cardContent;

            if (options.cardImage.smallImageUrl) {
                alexaResponse.card.image['smallImageUrl'] = options.cardImage.smallImageUrl;
            }

            if (options.cardImage.largeImageUrl) {
                alexaResponse.card.image['largeImageUrl'] = options.cardImage.largeImageUrl;
            }
        }
    } else if (options.cardType === 'LinkAccount') {
        alexaResponse.card = {
            type: 'LinkAccount'
        };
    } else if (options.cardType === 'AskForPermissionsConsent') {
        alexaResponse.card = {
            type: 'AskForPermissionsConsent',
            permissions: options.permissions
        };
    }

    var returnResult = {
        version: '1.0',
        response: alexaResponse
    };

    if (options.sessionAttributes) {
        returnResult.sessionAttributes = options.sessionAttributes;
    }
    return returnResult;
}
// End SDK fixes



/**
 * This is a small wrapper client for the Alexa Address API.
 */
class AlexaDeviceAddressClient {

    /**
     * Retrieve an instance of the Address API client.
     * @param apiEndpoint the endpoint of the Alexa APIs.
     * @param deviceId the device ID being targeted.
     * @param consentToken valid consent token.
     */
    constructor(apiEndpoint, deviceId, consentToken) {
        console.log("Creating AlexaAddressClient instance.");
        this.deviceId = deviceId;
        this.consentToken = consentToken;
        this.endpoint = apiEndpoint.replace(/^https?:\/\//i, "");
    }

    /**
     * This will make a request to the Address API using the device ID and
     * consent token provided when the Address Client was initialized.
     * This will retrieve the full address of a device.
     * @return {Promise} promise for the request in flight.
     */
    getFullAddress() {
        const options = this.__getRequestOptions(`/v1/devices/${this.deviceId}/settings/address`);

        return new Promise((fulfill, reject) => {
            this.__handleDeviceAddressApiRequest(options, fulfill, reject);
        });
    }

    /**
     * This will make a request to the Address API using the device ID and
     * consent token provided when the Address Client was initialized.
     * This will retrieve the country and postal code of a device.
     * @return {Promise} promise for the request in flight.
     */
    getCountryAndPostalCode() {
        const options = this.__getRequestOptions(
            `/v1/devices/${this.deviceId}/settings/address/countryAndPostalCode`);

        return new Promise((fulfill, reject) => {
            this.__handleDeviceAddressApiRequest(options, fulfill, reject);
        });
    }

    /**
     * This is a helper method that makes requests to the Address API and handles the response
     * in a generic manner. It will also resolve promise methods.
     * @param requestOptions
     * @param fulfill
     * @param reject
     * @private
     */
    __handleDeviceAddressApiRequest(requestOptions, fulfill, reject) {
        https.get(requestOptions, (response) => {
            console.log(`Device Address API responded with a status code of : ${response.statusCode}`);

            response.on('data', (data) => {
                let responsePayloadObject = JSON.parse(data);

                const deviceAddressResponse = {
                    statusCode: response.statusCode,
                    address: responsePayloadObject
                };

                fulfill(deviceAddressResponse);
            });
        }).on('error', (e) => {
            console.error(e);
            reject();
        });
    }

    /**
     * Private helper method for retrieving request options.
     * @param path the path that you want to hit against the API provided by the skill event.
     * @return {{hostname: string, path: *, method: string, headers: {Authorization: string}}}
     * @private
     */
    __getRequestOptions(path) {
        return {
            hostname: this.endpoint,
            path: path,
            method: 'GET',
            'headers': {
                'Authorization': 'Bearer ' + this.consentToken
            }
        };
    }
}
