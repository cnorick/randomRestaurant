/* eslint-disable  func-names */
/* eslint quote-props: ["error", "consistent"]*/

'use strict';

const Alexa = require('ask-sdk-core');
const https = require('https');

const APP_ID = process.env.app_id;
const API_KEY = process.env.api_key;


const responses = {
    SKILL_NAME: 'Random Restaurant',
    GET_RESTAURANT_MESSAGE: "Try out ",
    HELP: 'You can say find a random restaurant or you may specify a specific type and price of restaurant. For example, find a cheap chinese restaurant... What can I help you with?',
    HELP_REPROMPT: 'What can I help you with?',
    GOODBYE: 'Goodbye!',
    YELP_ATTRIBUTION: ' ... Nearby restaurants provided by Yelp',
    NOTIFY_MISSING_PERMISSIONS: 'Please enable Location permissions in the Amazon Alexa app.',
    NO_ADDRESS: "It looks like you don't have an address set. You can set your address from the companion app.",
    ERROR: "Uh Oh. Looks like something went wrong.",
    UNHANDLED: 'This skill doesn\'t support that. Please ask something else.',
    LOCATION_FAILURE: 'There was an error with the Device Address API. Make sure your address is set in the Alex app and try again.',
};

const PERMISSIONS = [`read::alexa:device:all:address`];

const GetRestaurantIntent = {
    canHandle(handlerInput) {
        const { request } = handlerInput.requestEnvelope;

        return request.type === 'IntentRequest' && request.intent.name === 'GetRestaurantIntent';
    },
    async handle(handlerInput) {
        const { requestEnvelope, responseBuilder } = handlerInput;
        const { request } = requestEnvelope;

        let address;

        try {
            address = await GetAddress(handlerInput);
        } catch (error) {
            if (error.name === 'AddressError') {
                return error.responseBuilder;
            }
            else throw error;
        }

        let { priceRange, requestedPrice, foodType, requestedType } = getSlots(request.intent);
        const restaurant = await GetRandomRestaurant(address, foodType, priceRange);

        if (!restaurant) {
            const speech = `There are no ${requestedPrice || ''} ${requestedType || ''} restaurants open in your area. Make sure your address is up to date in the Alexa app, or try different search parameters.`;
            return responseBuilder
                .speak(speech)
                .withShouldEndSession(true)
                .getResponse();
        }


        const speech = buildSpeechOutput(restaurant, requestedPrice);
        const card = buildCard(restaurant);
        return responseBuilder
            .speak(speech)
            .withStandardCard(card.title, card.content, card.image.smallImageUrl, card.image.largeImageUrl)
            .getResponse();
    }
};

const LaunchRequest = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'LaunchRequest';
    },
    async handle(handlerInput) {
        // Automatically use the GetRestaurantIntent on launch if no intent specified.
        return GetRestaurantIntent.handle(handlerInput);
    }
};

const HelpIntent = {
    canHandle(handlerInput) {
        const { request } = handlerInput.requestEnvelope;

        return request.type === 'IntentRequest' && request.intent.name === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak(responses.HELP)
            .reprompt(responses.HELP)
            .getResponse();
    }
}

const CancelIntent = {
    canHandle(handlerInput) {
        const { request } = handlerInput.requestEnvelope;

        return request.type === 'IntentRequest' && request.intent.name === 'AMAZON.CancelIntent';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak(responses.GOODBYE)
            .getResponse();
    },
};

const StopIntent = {
    canHandle(handlerInput) {
        const { request } = handlerInput.requestEnvelope;

        return request.type === 'IntentRequest' && request.intent.name === 'AMAZON.StopIntent';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak(responses.GOODBYE)
            .getResponse();
    },
};

const SessionEndedRequest = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        console.log(`Session ended with reason: ${handlerInput.requestEnvelope.request.reason}`);

        return handlerInput.responseBuilder.getResponse();
    },
};

const UnhandledIntent = {
    canHandle() {
        return true;
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak(responses.UNHANDLED)
            .reprompt(responses.UNHANDLED)
            .getResponse();
    },
};

const GetAddressError = {
    canHandle(handlerInput, error) {
        return error.name === 'ServiceError';
    },
    handle(handlerInput, error) {
        if (error.statusCode === 403) {
            return handlerInput.responseBuilder
                .speak(responses.NOTIFY_MISSING_PERMISSIONS)
                .withAskForPermissionsConsentCard(PERMISSIONS)
                .getResponse();
        }
        return handlerInput.responseBuilder
            .speak(responses.LOCATION_FAILURE)
            .reprompt(responses.LOCATION_FAILURE)
            .getResponse();
    },
};

const skillBuilder = Alexa.SkillBuilders.custom();

exports.handler = skillBuilder
    .addRequestHandlers(
        LaunchRequest,
        GetRestaurantIntent,
        SessionEndedRequest,
        HelpIntent,
        CancelIntent,
        StopIntent,
        UnhandledIntent,
    )
    .addErrorHandlers(GetAddressError)
    .withApiClient(new Alexa.DefaultApiClient())
    .lambda();


// Checks if the user has address permissions and an address saved. If they don't have both, then
// the method throws an AddressError. It contains a responseBuilder that can be returned from a handler.
// Otherwise, if the user has both, then the method returns an address string.
async function GetAddress(handlerInput) {
    const { requestEnvelope, serviceClientFactory, responseBuilder } = handlerInput;

    const consentToken = requestEnvelope.context.System.user.permissions
        && requestEnvelope.context.System.user.permissions.consentToken;
    if (!consentToken) {
        let error = new Error("No address permissions");
        error.name = "AddressError";
        error.responseBuilder = responseBuilder
            .speak(responses.NOTIFY_MISSING_PERMISSIONS)
            .withAskForPermissionsConsentCard(PERMISSIONS)
            .getResponse();
        throw error;
    }
    try {
        const { deviceId } = requestEnvelope.context.System.device;
        const deviceAddressServiceClient = serviceClientFactory.getDeviceAddressServiceClient();
        const addressResponse = await deviceAddressServiceClient.getFullAddress(deviceId);

        if (addressResponse.addressLine1 === null && addressResponse.stateOrRegion === null && addressResponse.postalCode === null) {
            let error = new Error("Missing address");
            error.name = "AddressError";
            error.responseBuilder = responseBuilder.speak(responses.NO_ADDRESS).getResponse();
            throw error;
        } else {
            let address = '';
            for (let prop in addressResponse) {
                if (addressResponse[prop] !== null) {
                    address += addressResponse[prop] + ' ';
                }
            }
            return address;
        }
    } catch (error) {
        if (error.name !== 'ServiceError' && error.name !== 'AddressError') {
            error.name = 'AddressError';
            error.response = responseBuilder.speak(responses.ERROR).getResponse();
        }
        throw error;
    }
};

// Chooses a random restaurant from a list returned from yelp.
async function GetRandomRestaurant(address, foodType, priceRange) {
    const businesses = await QueryYelp(address, foodType, priceRange);
    if (businesses.length === 0) {
        return null;
    }
    const randIndex = Math.floor(Math.random() * businesses.length);
    return businesses[randIndex];
}

// Returns a list of businesses from yelp that meet the specified criteria.
async function QueryYelp(address, foodType, priceRange) {
    const options = {
        host: 'api.yelp.com',
        port: 443,
        path: buildPath(address, foodType, priceRange),
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + API_KEY
        }
    };

    // Wrap the web request in a promise to be awaited.
    return new Promise(function (resolve, reject) {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (d) => {
                body += d;
            });
            res.on('end', () => {
                let parsedData = JSON.parse(body);
                resolve(parsedData.businesses);
            });
        });
        req.on('error', (e) => {
            console.error(e);
            reject(e)
        });

        req.end();
    });
}

// Build yelp query path.
function buildPath(location, foodType, priceRange) {
    const term = 'restaurant';
    const encodedLocation = encodeURIComponent(location);
    let url = `/v3/businesses/search?term=${term}&location=${encodedLocation}&open_now&price=${priceRange}`;
    if (foodType)
        url += `&categories=${foodType}`;
    return url;
}

function buildSpeechOutput(restaurant, requestedPrice) {
    const category = restaurant.categories[0].title;
    const distance = (restaurant.distance * 0.000621371).toFixed(1); // miles
    const name = sanitize(restaurant.name);

    const response = `${name} is ${distance} miles away if you're in the mood for ${requestedPrice || ''} ${category}...
        Check the Alexa app for address and more information`;

    console.log(response);
    return response;
}

function buildCard(restaurant) {
    const address = restaurant.location.display_address.join('\n');
    const phone = restaurant.phone;
    const url = restaurant.url;
    const content = `${address}
    ${phone}
    
    Nearby restaurant search provided by Yelp.
    `;
    return {
        title: restaurant.name,
        content: content,
        image: {
            smallImageUrl: restaurant.image_url,
            largeImageUrl: restaurant.image_url
        }
    };
}

function sanitize(str) {
    return str.replace('&', 'and');
}

// Pulls information from the intent.
// Returns an object containing what the user actually said, and what price range and food type got matched with that request.
function getSlots(intent) {
    let ft = [];
    let returnObj = {};

    try {
        // values contains tuples of (name, id).
        // name is what the user asked for exactly. id is the type of food related to that name.
        let values = intent.slots.foodtype.resolutions.resolutionsPerAuthority[0].values;
        for (let v of values) {
            ft.push(v.value.id);
        }
        returnObj.foodType = ft.join(',');
        returnObj.requestedType = intent.slots.foodtype.value;
    }
    catch (e) {
        console.log(e)
        if (!e instanceof TypeError) {
            throw e;
        }
        returnObj.foodType = null;
        returnObj.requestedType = null;
    }

    let pr;
    try {
        pr = intent.slots.price.resolutions.resolutionsPerAuthority[0].values[0].value.id;
        returnObj.requestedPrice = intent.slots.price.value;
    }
    catch (e) {
        if (!e instanceof TypeError) {
            throw e;
        }
        pr = null;
        returnObj.requestedPrice = null;
    }

    switch (pr) {
        case 'cheap':
            returnObj.priceRange = '1,2';
            break;
        case 'mid':
            returnObj.priceRange = '2,3';
            break;
        case 'expensive':
            returnObj.priceRange = '3,4';
            break;
        default:
            returnObj.priceRange = '1,2,3,4';
            break;
    }

    return returnObj;
}
