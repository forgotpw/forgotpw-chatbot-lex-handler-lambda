const logger = require('./logger');
const authorizedRequest = require('./lib/authorizedRequest');
const config = require('./config');
const Mustache = require('mustache')
const ApplicationService = require('./lib/applicationService')
const PhoneTokenService = require('phone-token-service')
const DashbotLib = require('./lib/dashbotLib');
const TwilioLib = require('./lib/twilioLib');

async function handler(event, context, callback)  {
    try {
        // format of event object:
        // https://docs.aws.amazon.com/lex/latest/dg/lambda-input-response-format.html

        // if the userId is not a phone number, such as if testing in the AWS Lex
        // console, the userId field will appear like vku38bqtk0388hdr74stria0ba0y7s4f
        // so if the userId is 32 chars and contains any letter we'll know it's testing
        // and force the userId/phone to a testing phone
        if (event.userId.length >= 32 && event.userId.match(/^[A-Z]/i)) {
            event.userId = '12125551212';
            console.warn(`Test usasge detected, overriding event.userId to ${event.userId}`);
        }

        const phoneTokenService = new PhoneTokenService({
            tokenHashHmac: config.USERTOKEN_HASH_HMAC,
            s3bucket: config.USERTOKENS_S3_BUCKET,
            defaultCountryCode: 'US'
          });
        const phone = event.userId;
        const exists = await phoneTokenService.doesTokenExistForPhone(phone);
        const firstTime = !exists;
        const userToken = await phoneTokenService.getTokenFromPhone(phone);

        // create a cleansed version of the event object to send to dashbot for analytics
        // (specifically strip out userId / phone)
        let platformJson = {
            currentIntent: event.currentIntent,
            bot: event.bot,
            invocationSource: event.invocationSource,
            outputDialogMode: event.outputDialogMode,
            sessionAttributes: event.sessionAttributes,
            requestAttributes: event.requestAttributes
        }

        await DashbotLib.logIncomingToDashbot(
            userToken,
            event.inputTranscript,
            platformJson);

        let lexResponse = await dispatchIntent(userToken, firstTime, event);

        await DashbotLib.logOutgoingToDashbot(
            userToken,
            lexResponse.dialogAction.message.content,
            platformJson);
    
        callback(null, lexResponse);
    }
    catch (err) {
        callback(err);
    }
};

function lexResponse(sessionAttributes, fulfillmentState, message) {
    return {
        sessionAttributes,
        dialogAction: {
            type: 'Close', // known type ids = [Close, ConfirmIntent, Delegate, DialogAction, ElicitIntent, ElicitSlot]
            fulfillmentState,
            message: { 'contentType': 'PlainText', 'content': `${message}` }
        },
    };
}

async function dispatchIntent(userToken, firstTime, event) {
    const intentName = event.currentIntent.name;
    logger.info(`request received for userId=${event.userId}, intentName=${intentName}`);
    logger.debug(`slots: ${JSON.stringify(event.currentIntent.slots)}`);

    switch(intentName) {
        case 'Hello':
            return await helloController(event, userToken, firstTime);
        case 'SendVcard':
            return await sendVcardController(event, userToken);
        case 'Help':
            return await helpController(event);
        case 'StorePassword':
            return await storePasswordController(event);
        case 'RetrievePassword':
            return await retrievePasswordController(event, userToken);
        default:
            logger.error(`Unhandled intent received: ${intentName}`);
            return lexResponse(
                event.sessionAttributes,
                'Failed',
                `Sorry I'm not sure how to help with that.`
            );
    }
}

async function readTemplate(templateName) {
    const fs = require('fs');
    const util = require('util');
    const readFile = util.promisify(fs.readFile);
    const contents = await readFile(`chat-templates/${templateName}`, 'utf8');
    return contents;
}

async function helloController(event, userToken, firstTime) {
    const sessionAttributes = event.sessionAttributes;
    const phone = event.userId;

    let msg = '';
    let templateFilename = null;
    if (firstTime) {
        templateFilename = 'hello-firsttime.tmpl';
        // TODO: mark as not first time visitor anymore ?
        // (this will happen automatically after storing or retrieving any password)
    } else {
        templateFilename = 'hello.tmpl';
    }

    const template = await readTemplate(templateFilename);
    msg = template;

    if (firstTime) {
        await sendVcard(phone, userToken);
    }

    return lexResponse(
        sessionAttributes,
        'Fulfilled',
        msg
    );
}

async function sendVcardController(event, userToken) {
    const sessionAttributes = event.sessionAttributes;
    const phone = event.userId;

    await TwilioLib.sendVcard(phone, userToken);

    const template = await readTemplate('vcard.tmpl');
    let msg = template;

    return lexResponse(
        sessionAttributes,
        'Fulfilled',
        msg
    );
}

async function helpController(event) {
    const sessionAttributes = event.sessionAttributes;

    let firstTime = true;
    let msg = '';

    if (firstTime) {
        const template = await readTemplate('help.tmpl');
        msg = template;
    }

    return lexResponse(
        sessionAttributes,
        'Fulfilled',
        msg
    );
}

async function storePasswordController(event) {
    const sessionAttributes = event.sessionAttributes;
    const slots = event.currentIntent.slots;
    const rawApplication = slots.Application;
    const phone = event.userId;

    const arid = await authorizedRequest.generateAuthorizedRequestFromPhone(phone, rawApplication);
    const template = await readTemplate('store.tmpl');
    const subdomain = config.AWS_ENV == 'dev' ? 'app-dev' : 'app';
    const viewData = {
        rawApplication,
        url: `https://${subdomain}.rosa.bot/#/set?arid=${arid}`
    }
    let msg = Mustache.render(template, viewData);
    
    return lexResponse(
        sessionAttributes,
        'Fulfilled',
        msg
    );
}

async function retrievePasswordController(event, userToken) {
    const sessionAttributes = event.sessionAttributes;
    const slots = event.currentIntent.slots;
    const rawApplication = slots.Application;
    const phone = event.userId;
  
    const applicationService = new ApplicationService();
    const foundApplication = await applicationService.findApplication(rawApplication, userToken);
    let msg = '';
    if (foundApplication.matchType == 'NOTFOUND') {
        const template = await readTemplate('retrieve-notfound.tmpl');
        const viewData = {
            rawApplication
        }
        msg = Mustache.render(template, viewData);
    } else {
        let templateFile = null;
        if (foundApplication.matchType == 'EXACT_FOUND') {
            templateFile = 'retrieve.tmpl';
        } else {
            templateFile = 'retrieve-similarfound.tmpl';
        }
        // generateAuthorizedRequestFromPhone expects rawApplication but it immediately
        // converts it to normalized, and since we only have normalizedApplication here, it's
        // okay to send that, running it through normalization function again won't change anything
        const arid = await authorizedRequest.generateAuthorizedRequestFromPhone(phone, foundApplication.normalizedApplication);
        const template = await readTemplate(templateFile);
        const subdomain = config.AWS_ENV == 'dev' ? 'app-dev' : 'app';
        const viewData = {
            rawApplication,
            url: `https://${subdomain}.rosa.bot/#/get?arid=${arid}`
        }
        msg = Mustache.render(template, viewData);
    }
    
    return lexResponse(
        sessionAttributes,
        'Fulfilled',
        msg
    );
}

module.exports.handler = handler
