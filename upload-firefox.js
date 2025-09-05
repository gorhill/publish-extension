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

async function checkSignature(packagePathIn, packagePathOut, manifest) {
    const jwt = new utils.JWT(process.env.AMO_API_KEY, process.env.AMO_SECRET);
    console.log('Waiting for AMO to process the request to sign the self-hosted xpi package...');
    const signingCheckURL =
    `https://addons.mozilla.org/api/v5/addons/addon/${amoExtensionId}/versions/${manifest.version}/`;
    const signingCheckRequest = new Request(signingCheckURL, {
        headers: {
            Accept: 'application/json',
            Authorization: jwt.getToken(),
        },
    });
    const {
        response: signingCheckResponse,
        data: signingCheckDetails,
    } = await utils.fetchEx(signingCheckRequest, 'json');
    if ( signingCheckResponse.ok !== true ) {
        console.log(`Error: AMO lookup failed -- server error ${signingCheckResponse.status}`);
        process.exit(1);
    }
    const { file } = signingCheckDetails;
    console.log(`AMO validation: ${file?.status}`);
    if ( file.status === 'disabled' ) {
        console.log('Error: AMO signing failed')
        process.exit(1);
    }
    if ( file.status === 'unreviewed' ) {
        console.log('Error: AMO signing is pending')
        process.exit(1);
    }
    console.log('Success: xpi package successfully signed')

    console.log(`Downloading signed self-hosted xpi package from ${file.url}...`);
    const downloadRequest = new Request(file.url, {
        headers: {
            Accept: 'application/octet-stream',
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
        'Upload to GitHub:',
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

    const tempDir = await fs.mkdtemp('/tmp/github-asset-');
    const signedPackageName = assetInfo.name.replace('.xpi', '.signed.xpi');
    const signedPackagePath = `${tempDir}/${signedPackageName}`

    await checkSignature(packagePath, signedPackagePath, manifest);

    // Upload to GitHub
    const uploadResult = await ghapi.uploadAssetToRelease(signedPackagePath, 'application/zip');
    if ( uploadResult === undefined ) {
        console.log(`Failed to upload signed package to ${ghapi.details.owner}/${ghapi.details.repo}/${ghapi.details.tag}`);
        process.exit(1);
    }

    // Delete unsigned package from GitHub
    await ghapi.deleteAssetFromRelease(assetInfo.url);

    // If self-hosted, patch update file and commit
    if ( amoChannel === 'unlisted' && autoUpdatepath !== '' ) {
        const r = await ghapi.updateFirefoxAutoUpdateFile(autoUpdatepath, {
            amoExtensionId,
            manifest,
            signedPackageName,
        });
        if ( Boolean(r) === false ) {
            console.log('Auto-update details not brought up to date');
        }
    }

    // Clean up
    if ( commandLineArgs.keep !== true ) {
        {
            const tmpdir = path.dirname(packagePath);
            console.log(`Removing ${tmpdir}`);
            utils.shellExec(`rm -rf "${tmpdir}"`);
        }
        {
            const tmpdir = path.dirname(signedPackagePath);
            console.log(`Removing ${tmpdir}`);
            utils.shellExec(`rm -rf "${tmpdir}"`);
        }
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
