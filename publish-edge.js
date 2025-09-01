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
const productId = commandLineArgs.productid;

/******************************************************************************/

async function extensionNameFromEdgeStore() {
    const { data } = await utils.fetchEx(
        `https://microsoftedge.microsoft.com/addons/detail/${storeId}`,
        'text'
    );
    if ( data === undefined ) { return '?'; }
    const match = /<title>([^-<]+)[^<]*?<\/title>/.exec(data);
    if ( match === null ) { return '?'; }
    return match[1].trim();
}

/******************************************************************************/

async function publishToEdgeStore(filePath) {
    const edgeApiKey = process.env.EDGE_API_KEY;
    const edgeClientId = process.env.EDGE_CLIENT_ID;
    const uploadURL = `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions/draft/package`;

    // Read package
    const data = await fs.readFile(filePath);

    // Upload
    console.log(`Uploading package to ${uploadURL}`);
    const uploadRequest = new Request(uploadURL, {
        body: data,
        headers: {
            'Authorization': `ApiKey ${edgeApiKey}`,
            'X-ClientID': edgeClientId,
            'Content-Type': 'application/zip'
        },
        method: 'POST',
    });
    const { response: uploadResponse } = await utils.fetchEx(uploadRequest);
    if ( uploadResponse.status !== 202 ) {
        console.log(`Upload failed -- server error ${uploadResponse.status}`);
        process.exit(1);
    }
    const operationId = uploadResponse.headers.get('Location');
    if ( operationId === undefined ) {
        console.log(`Upload failed -- missing Location header`);
        process.exit(1);
    }
    console.log(`Upload succeeded`);

    // Check upload status
    console.log('Checking upload status...');
    const interval = 60;                // check every 60 seconds
    let countdown = 15 * 60 / interval; // for at most 15 minutes
    for (;;) {
        await utils.sleep(interval);
        countdown -= 1
        if ( countdown <= 0 ) {
            console.log('Error: Microsoft store timed out')
            process.exit(1);
        }
        const uploadStatusRequest = new Request(`${uploadURL}/operations/${operationId}`, {
            headers: {
                'Authorization': `ApiKey ${edgeApiKey}`,
                'X-ClientID': edgeClientId,
            },
        });
        const {
            response: uploadStatusResponse,
            data: uploadStatusDict,
        } = await utils.fetchEx(uploadStatusRequest, 'json');
        if ( uploadStatusResponse.status !== 200 ) {
            console.log(`Upload status check failed -- server error ${uploadStatusResponse.status}`);
            process.exit(1);
        }
        const { status } = uploadStatusDict;
        if ( status === undefined || status === 'Failed' ) {
            console.log(`Upload status check failed -- server error ${status}`);
            process.exit(1);
        }
        if ( status === 'InProgress' ) { continue }
        console.log('Package ready to be published.')
        break;
    }

    // Publish
    // https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/update/api/addons-api-reference?tabs=v1-1#publish-the-product-draft-submission
    console.log('Publish package...')
    const publishURL = `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions`;
    const publishNotes = {
        'Notes': 'See official release notes at <https://github.com/gorhill/uBlock/releases>'
    }
    const publishRequest = new Request(publishURL, {
        body: JSON.stringify(publishNotes),
        headers: {
            'Authorization': `ApiKey ${edgeApiKey}`,
            'X-ClientID': edgeClientId,
        },
        method: 'POST',
    });
    const { response: publishResponse } = await utils.fetchEx(publishRequest);
    if ( publishResponse.status !== 202 ) {
        console.log(`Publish failed -- server error ${publishResponse.status}`);
        process.exit(1);
    }
    if ( publishResponse.headers.get('Location') === undefined ) {
        console.log(`Publish failed -- missing Location header`);
        process.exit(1);
    }
    console.log('Publish succeeded.')
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
    const edgeStoreName = await extensionNameFromEdgeStore();
    const manifestName = await utils.getExtensionNameFromPackage(packagePath);
    if ( manifestName && manifestName !== edgeStoreName ) {
        console.log(`Extension name mismatch between manifest and Edge Store:\n  "${manifestName}" != "${edgeStoreName}"`);
        process.exit(1);
    }

    const manifest = await utils.getManifestFromPackage(packagePath);
    if ( manifest === undefined ) {
        process.exit(1);
    }
    let updateManifest = false;

    if ( commandLineArgs.datebasedmajor !== undefined ) {
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth() + 1;
        const day = now.getUTCDate();
        const major = `${year}.${month * 100 + day}`;
        manifest.version = manifest.version.replace(/^\d+/, major);
        updateManifest = true;
    }

    const versionName = ghapi.details.tag.replace(/^\D+/, '');
    if ( versionName !== manifest.version ) {
        manifest.version_name = versionName;
        updateManifest = true;
    }

    if ( updateManifest ) {
        await utils.updateManifestInPackage(packagePath, manifest);
    }

    await utils.prompt([
        'Publish to Edge store:',
        `  GitHub owner: "${ghapi.details.owner}"`,
        `  GitHub repo: "${ghapi.details.repo}"`,
        `  Release tag: "${ghapi.details.tag}"`,
        `  Asset name: "${assetInfo.name}"`,
        `  Extension names: "${manifestName}" / "${edgeStoreName}"`,
        `  Extension id: ${storeId}`,
        `  Extension version: ${manifest.version}`,
        `  Extension version name: ${manifest.version_name || '[empty]'}`,
        `  Product id: ${productId}`,
        `Publish? (enter "yes"): `,
    ].join('\n'));

    process.exit(1);

    // Upload to Edge Store
    await publishToEdgeStore(packagePath);

    // Clean up
    if ( commandLineArgs.keep !== true ) {
        const tmpdir = path.dirname(packagePath);
        console.log(`Removing ${tmpdir}`);
        utils.shellExec(`rm -rf "${tmpdir}"`);
    }

    console.log('Done');
}

main().then(result => {
    if ( result !== undefined ) {
        console.log(result);
        process.exit(1);
    }
    process.exit(0);
});
