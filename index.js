/* eslint-disable  func-names */
/* eslint quote-props: ["error", "consistent"]*/

'use strict';

const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk')
const https = require('https');
const ddb = new AWS.DynamoDB({ apiVersion: '2012-10-08' });


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

        let addressObject;

        try {
            addressObject = await GetAddress(handlerInput);
        } catch (error) {
            if (error.name === 'AddressError') {
                return error.responseBuilder;
            }
            else throw error;
        }

        let { priceRange, requestedPrice, foodType, requestedType } = getSlots(request.intent);
        const restaurant = await GetRandomRestaurant(addressObject.string, foodType, priceRange);

        if (!restaurant) {
            const speech = `There are no ${requestedPrice || ''} ${requestedType || ''} restaurants open in your area. Make sure your address is up to date in the Alexa app, or try different search parameters.`;
            return responseBuilder
                .speak(speech)
                .withShouldEndSession(true)
                .getResponse();
        }


        await StoreInteraction(handlerInput, addressObject.object, requestedPrice, requestedType, foodType, priceRange, restaurant);

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
            return { string: address, object: addressResponse };
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
    const name = restaurant.name;

    const response = `${name} is ${distance} miles away if you're in the mood for ${requestedPrice || ''} ${category}...
        Check the Alexa app for address and more information`;

    console.log(response);
    return sanitize(response);
}

function buildCard(restaurant) {
    const address = restaurant.location.display_address.join('\n');
    const phone = restaurant.display_phone || restaurant.phone;

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
    str = str.replace("'", "\'");
    // May need to escape other characters too in the future.
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

async function StoreInteraction(handlerInput, address, requestedPrice, requestedType, foodType, priceRange, restaurant) {
    await StoreToDynamo(handlerInput, address, requestedPrice, requestedType, foodType, priceRange, restaurant);
}

async function StoreToDynamo(handlerInput, address, requestedPrice, requestedType, foodType, priceRange, restaurant) {
    const { requestEnvelope } = handlerInput;

    const userId = requestEnvelope.session && requestEnvelope.session.user && requestEnvelope.session.user.userId;
    const timestamp = requestEnvelope.request && requestEnvelope.request.timestamp;
    const deviceId = requestEnvelope.context && requestEnvelope.context.System && requestEnvelope.context.System.device && requestEnvelope.context.System.device.deviceId;
    const locale = requestEnvelope.request && requestEnvelope.request.locale;

    console.log(restaurant)
    const params = {
        TableName: 'RandomRestaurantUses',
        Item: {
            'userId': { S: userId },
            'timestamp': { S: timestamp },
            'deviceId': { S: deviceId },
            'locale': { S: locale },
            'requestedFoodType': { S: requestedType },
            'matchedFoodType': { S: foodType },
            'requestedPrice': { S: requestedPrice },
            'matchedPrice': { S: priceRange },
            'recommendedRestaurantName': { S: restaurant.name },
            'recommendedRestaurantAlias': { S: restaurant.alias },
            'recommendedRestaurantRating': { N: restaurant.rating && restaurant.rating.toString() },
            'recommendedRestaurantPrice': { S: restaurant.price },
            'recommendedRestaurantDistance': { N: restaurant.distance && restaurant.distance.toString() },
            'recommendedRestaurantZip': { N: restaurant.location && restaurant.location.zip_code },
        }
    };

    // Save each of the address fields to the item.
    for (let prop in address) {
        if (isNaN(address[prop])) {
            params.Item[prop] = { S: address[prop] };
        }
        else { // If it is a number
            params.Item[prop] = { N: address[prop] };
        }
    }

    // If any of the properties are null, this removes them from the Item object.
    // dynamodb doesn't like nulls or empty strings.
    for (let prop in params.Item) {
        if (!params.Item[prop][Object.keys(params.Item[prop])[0]])
            delete params.Item[prop];
    }

    if(params.Item.postalCode && params.Item.postalCode.S) {
        params.Item.postalCode.N = params.Item.postalCode.S.split('-')[0]; // Remove the last part of the zip code if it's there.
        delete params.Item.postalCode.S;
    }


    // Call DynamoDB to add the item to the table
    ddb.putItem(params, function (err, data) {
        if (err) {
            console.log("Error saving to db", err);
        } else {
            console.log("Successfully saved to db", data);
        }
    });
}

// async function StoreToSQL(handlerInput, address, requestedPrice, requestedType, foodType, priceRange, restaurant) {
//     var mysql = require('mysql');

//     var connection = mysql.createConnection({
//         host: process.env.RDS_HOSTNAME,
//         user: process.env.RDS_USERNAME,
//         password: process.env.RDS_PASSWORD,
//         port: process.env.RDS_PORT
//     });

//     connection.connect(function (err) {
//         if (err) {
//             console.error('Database connection failed: ' + err.stack);
//             return;
//         }

//         console.log('Connected to database.');
//     });

//     var post = { id: 1, title: 'Hello MySQL' };
//     var query = connection.query('INSERT INTO Invocation SET ?', post, function (error, results, fields) {
//         if (error) throw error;
//         // Neat!
//     });
//     consol

//     connection.end();
// }