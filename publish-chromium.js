/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2025-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import * as fs from 'node:fs/promises';
import * as ghapi from './github-api.js';
import * as utils from './utils.js';
import path from 'node:path';
import process from 'node:process';

/******************************************************************************/

const commandLineArgs = utils.commandLineArgs;
const storeId = commandLineArgs.storeid;

/******************************************************************************/

async function extensionNameFromCWS() {
    const { data } = await utils.fetchEx(
        `https://chromewebstore.google.com/detail/${storeId}`,
        'text'
    );
    if ( data === undefined ) { return '?'; }
    const match = /<title>([^-<]+)[^<]*?<\/title>/.exec(data);
    if ( match === null ) { return '?'; }
    return match[1].trim();

}

/******************************************************************************/

async function publishToCWS(filePath) {
    // Prepare access token
    console.log('Generating access token...');
    const authURL = 'https://accounts.google.com/o/oauth2/token';
    const authRequest = new Request(authURL, {
        body: JSON.stringify({
            client_id: process.env.CWS_ID,
            client_secret: process.env.CWS_SECRET,
            grant_type: 'refresh_token',
            refresh_token: process.env.CWS_REFRESH,
        }),
        method: 'POST',
    });
    const {
        response: authResponse,
        data: responseDict,
    } = await utils.fetchEx(authRequest, 'json');
    if ( responseDict === undefined ) {
        console.error(`Error: Auth failed -- server error ${authResponse.statusText}`);
        process.exit(1);
    }
    if ( responseDict.access_token === undefined ) {
        console.error('Error: Auth failed -- no access token');
        console.error('Error: Auth failed --', JSON.stringify(responseDict, null, 2));
        process.exit(1);
    }
    const cwsAuth = `Bearer ${responseDict.access_token}`;

    // Read package
    const data = await fs.readFile(filePath);

    // Upload
    console.log('Uploading package...')
    const uploadURL = `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${storeId}`;
    const uploadRequest = new Request(uploadURL, {
        body: data,
        headers: {
            'Authorization': cwsAuth,
            'x-goog-api-version': '2',
        },
        method: 'PUT',
    });
    const {
        response: uploadResponse,
        data: uploadDict,
    } = await utils.fetchEx(uploadRequest, 'json');
    if ( uploadDict === undefined ) {
        console.error(`Upload failed -- server error ${uploadResponse.statusText}`);
        process.exit(1)
    }
    if ( uploadDict.uploadState !== 'SUCCESS' ) {
        console.error(`Upload failed -- server error ${JSON.stringify(uploadDict)}`);
        process.exit(1);
    }
    console.log('Upload succeeded.')

    // Publish
    console.log('Publishing package...')
    const publishURL = `https://www.googleapis.com/chromewebstore/v1.1/items/${storeId}/publish`;
    const publishRequest = new Request(publishURL, {
        headers: {
            'Authorization': cwsAuth,
            'x-goog-api-version': '2',
            'Content-Length': '0',
        },
        method: 'POST',
    });
    const {
        response: publishResponse,
        data: publishDict,
    } = await utils.fetchEx(publishRequest, 'json');
    if ( publishDict === undefined ) {
        console.error(`Error: Chrome store publishing failed -- server error ${publishResponse.statusText}`);
        process.exit(1);
    }
    if (
        Array.isArray(publishDict.status) === false ||
        publishDict.status.includes('OK') === false
    ) {
        console.error(`Publishing failed -- server error ${publishDict.status}`);
        process.exit(1);
    }
    console.log('Publishing succeeded.')
}

/******************************************************************************/

async function main() {
    const assetInfo = await ghapi.getAssetInfo();
    if ( assetInfo === undefined ) {
        process.exit(1);
    }

    // Fetch asset from GitHub repo
    const packagePath = await ghapi.downloadAssetFromRelease(assetInfo);
    console.log('Asset saved at', packagePath);

    // Confirm the package being uploaded matches the store listing
    const cwsName = await extensionNameFromCWS();
    const manifestName = await utils.getExtensionNameFromPackage(packagePath);
    if ( manifestName && manifestName !== cwsName ) {
        console.log(`Extension name mismatch between manifest and CWS:\n  "${manifest.name}" != "${cwsName}"`);
        process.exit(1);
    }

    const manifest = await utils.getManifestFromPackage(packagePath);
    if ( manifest === undefined ) {
        process.exit(1);
    }
    let updateManifest = false;

    const versionName = ghapi.details.tag.replace(/^\D+/, '');
    if ( versionName !== manifest.version ) {
        manifest.version_name = versionName;
        updateManifest = true;
    }

    if ( updateManifest ) {
        await utils.updateManifestInPackage(packagePath, manifest);
    }

    await utils.prompt([
        'Publish to Chrome store:',
        `  GitHub owner: "${ghapi.details.owner}"`,
        `  GitHub repo: "${ghapi.details.repo}"`,
        `  Release tag: "${ghapi.details.tag}"`,
        `  Asset name: "${assetInfo.name}"`,
        `  Extension names: "${manifestName}" / "${cwsName}"`,
        `  Extension id: ${storeId}`,
        `  Extension version: ${manifest.version}`,
        `  Extension version name: ${manifest.version_name || '[empty]'}`,
        `Publish? (enter "yes"): `,
    ].join('\n'));

    // Upload to Chrome Web Store
    await publishToCWS(packagePath);

    // Clean up
    if ( commandLineArgs.keep !== true ) {
        {
            const tmpdir = path.dirname(packagePath);
            console.log(`Removing ${tmpdir}`);
            utils.shellExec(`rm -rf "${tmpdir}"`);
        }
    }

    console.log('Done');
}

main().then(result => {
    utils.cleanDo();
    if ( result !== undefined ) {
        console.log(result);
        process.exit(1);
    }
    process.exit(0);
});
