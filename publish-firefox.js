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
const amoExtensionId = commandLineArgs.storeid;
const amoChannel = commandLineArgs.channel || '';
const autoUpdatepath = commandLineArgs.updatepath || '';

/******************************************************************************/

// Stolen from:
// https://github.com/mozilla/web-ext/blob/960d49c3d5/src/util/submit-addon.js#L90-L111

async function fileFromSync(filePath) {
    // create a File blob from a file path, and ensure it to have the file path basename
    // as the associated filename, the AMO server API will be checking it on the form-data
    // submitted and fail with the error message:
    // "Unsupported file type, please upload a supported file (.crx, .xpi, .zip)."
    const fileData = await fs.readFile(filePath);
    return new File([ fileData ], path.basename(filePath));
}

/******************************************************************************/

async function requestSignature(packagePathIn, packagePathOut, manifest) {
    const [ amoApiKey, amoSecret ] = await Promise.all([
        utils.getSecret('amo_api_key'),
        utils.getSecret('amo_secret'),
    ]);
    const jwt = new utils.JWT(amoApiKey, amoSecret);

    const signingRequestURL =`https://addons.mozilla.org/api/v4/addons/${amoExtensionId}/versions/${manifest.version}/`;
    const formData = new FormData();
    formData.set('channel', amoChannel);
    formData.set('upload', await fileFromSync(packagePathIn));
    const signingRequest = new Request(signingRequestURL, {
        body: formData,
        headers: {
            Authorization: jwt.getToken(),
        },
        method: 'PUT',
    });
    console.log('Submitting package to be signed...');
    console.log(' ', signingRequestURL);
    const {
        response: signingRequestResponse,
        data: signingRequestDetails,
    } = await utils.fetchEx(signingRequest, 'json');
    if ( signingRequestResponse.ok !== true ) {
        console.log(`Error: Creating new version failed -- server error ${signingRequestResponse.status}`);
        process.exit(1);
    }
    console.log('Request for signing xpi package succeeded');

    if ( amoChannel !== 'unlisted' ) { return; }

    console.log('Waiting for AMO to process the request to sign the self-hosted xpi package...');
    const signingCheckURL = signingRequestDetails.url;
    const interval = 180 // check every 3 minutes
    let countdown = 30 * 60 / interval // for at most 30 minutes
    let downloadURL;
    for (;;) {
        await utils.sleep(60);
        countdown -= 1
        if ( countdown <= 0 ) {
            console.log('Error: AMO signing timed out');
            process.exit(1);
        }
        const signingCheckRequest = new Request(signingCheckURL, {
            headers: {
                Authorization: jwt.getToken(),
            },
        });
        const {
            response: signingCheckResponse,
            data: signingCheckDetails,
        } = await utils.fetchEx(signingCheckRequest, 'json');
        if ( signingCheckResponse.ok !== true ) {
            console.log(`Error: AMO signing failed -- server error ${signingCheckResponse.status}`);
            process.exit(1);
        }
        if ( signingCheckDetails.processed !== true ) { continue; }
        if ( signingCheckDetails.valid !== true ) {
            console.log('Error: AMO validation failed')
            process.exit(1);
        }
        if ( Array.isArray(signingCheckDetails.files) === false ) { continue; }
        if ( signingCheckDetails.files.length === 0 ) { continue; }
        if ( signingCheckDetails.files[0].signed !== true ) { continue; }
        downloadURL = signingCheckDetails.files[0].download_url;
        if ( Boolean(downloadURL) === false ) {
            console.log('Error: AMO signing failed')
            process.exit(1);
        }
        break;
    }
    console.log('Self-hosted xpi package successfully signed')

    console.log(`Downloading signed self-hosted xpi package from ${downloadURL}...`);
    const downloadRequest = new Request(downloadURL, {
        headers: {
            Authorization: jwt.getToken(),
        },
    });
    const {
        response: downloadResponse,
        data: signedPackage,
    } = await utils.fetchEx(downloadRequest, 'bytes');
    if ( downloadResponse.ok !== true ) {
        console.log(`Error: Download signed package failed -- server error ${downloadResponse.status}`);
        process.exit(1);
    }
    await fs.writeFile(packagePathOut, signedPackage);
    console.log(`Signed self-hosted xpi package downloaded at${packagePathOut}`);
}

/******************************************************************************/

async function main() {
    if ( /^(un)?listed$/.test(amoChannel) === false ) { return 'Need AMO channel'; }

    const assetInfo = await ghapi.getAssetInfo('firefox');
    if ( assetInfo === undefined ) {
        process.exit(1);
    }

    await utils.prompt([
        'Publish to AMO store:',
        `  GitHub owner: "${ghapi.details.owner}"`,
        `  GitHub repo: "${ghapi.details.repo}"`,
        `  Release tag: "${ghapi.details.tag}"`,
        `  Asset name: "${assetInfo.name}"`,
        `  Extension id: ${amoExtensionId}`,
        `  channel: ${amoChannel}`,
        `Publish? (enter "yes"): `,
    ].join('\n'));

    // Fetch asset from GitHub repo
    const packagePath = await ghapi.downloadAssetFromRelease(assetInfo);
    console.log(`Unsigned asset saved at ${packagePath}`);

    const manifest = await utils.getManifestFromPackage(packagePath);
    if ( manifest === undefined ) {
        console.log('Error: Unable to find manifest file');
        process.exit(1);
    }
    // If self-hosted, modify manifest with auto-update information
    if ( amoChannel === 'unlisted' ) {
        manifest.browser_specific_settings.gecko.update_url = 
        `https://raw.githubusercontent.com/${ghapi.details.owner}/${ghapi.details.repo}/master/dist/firefox/updates.json`;
        const r = await utils.updateManifestInPackage(packagePath, manifest);
        if ( r !== true ) {
            console.log('Error: Unable to update manifest file');
            process.exit(1);
        }
    }

    const tempDir = await utils.getTempDir();
    const signedPackageName = assetInfo.name.replace('.xpi', '.signed.xpi');
    const signedPackagePath = `${tempDir}/${signedPackageName}`

    await requestSignature(packagePath, signedPackagePath, manifest);

    // Upload to GitHub
    if ( amoChannel === 'unlisted' ) {
        const uploadResult = await ghapi.uploadAssetToRelease(signedPackagePath, 'application/zip');
        if ( uploadResult === undefined ) {
            console.log(`Failed to upload signed package to ${ghapi.details.owner}/${ghapi.details.repo}/${ghapi.details.tag}`);
            process.exit(1);
        }

        // Delete unsigned package from GitHub
        await ghapi.deleteAssetFromRelease(assetInfo.url);

        // Patch update file and commit
        if ( autoUpdatepath !== '' ) {
            const r = await ghapi.updateFirefoxAutoUpdateFile(autoUpdatepath, {
                amoExtensionId,
                manifest,
                signedPackageName,
            });
            if ( Boolean(r) === false ) {
                console.log('Auto-update details not brought up to date');
            }
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
