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
import process from 'node:process';

/******************************************************************************/

const commandLineArgs = utils.commandLineArgs;
const storeId = commandLineArgs.storeid;

const updateXmlTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="%extensionId%">
    <updatecheck codebase="%assetURL%" version="%assetVersion%" />
  </app>
</gupdate>
`;

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

async function publishToCWS(details) {
    if ( storeId === undefined ) { return; }
    const { assetInfo, manifest, packagePath } = details;

    // Confirm the package being uploaded matches the store listing
    const cwsName = await extensionNameFromCWS();
    const manifestName = await utils.getExtensionNameFromPackage(packagePath);
    if ( manifestName && manifestName !== cwsName ) {
        console.log(`Extension name mismatch between manifest and CWS:\n  "${manifest.name}" != "${cwsName}"`);
        process.exit(1);
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

    // Prepare access token
    console.log('Generating access token...');
    const [ cwsId, cwsSecret, cwsRefresh ] = await Promise.all([
        utils.getSecret('cws_id'),
        utils.getSecret('cws_secret'),
        utils.getSecret('cws_refresh'),
    ]);
    const authURL = 'https://accounts.google.com/o/oauth2/token';
    const authRequest = new Request(authURL, {
        body: JSON.stringify({
            client_id: cwsId,
            client_secret: cwsSecret,
            grant_type: 'refresh_token',
            refresh_token: cwsRefresh,
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
    const data = await fs.readFile(packagePath);

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
        return;
    }
    if ( uploadDict.uploadState !== 'SUCCESS' ) {
        console.error(`Upload failed -- server error ${JSON.stringify(uploadDict)}`);
        return;
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
        return;
    }
    if (
        Array.isArray(publishDict.status) === false ||
        publishDict.status.includes('OK') === false
    ) {
        console.error(`Publishing failed -- server error ${publishDict.status}`);
        return;
    }
    console.log('Publishing succeeded.')
}

/******************************************************************************/

async function publishToGithub(details) {
    const { crxupdatepath } = commandLineArgs;
    if ( crxupdatepath === undefined ) { return; }
    if ( commandLineArgs.crxkeytoken === undefined ) { return; }
    const crxKeyPath = await utils.getSecret(commandLineArgs.crxkeytoken);
    if ( crxKeyPath === undefined ) { return; }

    const tempDir = await utils.getTempDir();
    const { packagePath } = details;
    await utils.shellExec(`unzip ${packagePath} -d ${tempDir}`);
    const extDir = await utils.shellExec(`unzip -Z1 ${packagePath} | head -n1 | cut -d "/" -f1`);

    // Add update URL
    const branch = await utils.shellExec('git branch --show-current');
    const manifest = structuredClone(details.manifest);
    manifest.updateURL =         `https://raw.githubusercontent.com/${ghapi.details.owner}/${ghapi.details.repo}/${branch}/${crxupdatepath}`;
    await fs.writeFile(`${tempDir}/${extDir}/manifest.json`,
        JSON.stringify(manifest, null, 2)
    );

    // Create CRX package
    await utils.shellExec(`chromium \
        --pack-extension=${tempDir}/${extDir} \
        --pack-extension-key=${crxKeyPath}
    `);
    const { assetInfo } = details;
    const assetName = assetInfo.name.replace(/\.zip$/, '');
    await utils.shellExec(`mv ${tempDir}/${extDir}.crx ${tempDir}/${assetName}.crx`);

    // Upload to GitHub
    const uploadResult = await ghapi.uploadAssetToRelease(`${tempDir}/${assetName}.crx`,
        'application/x-chrome-package'
    );
    if ( uploadResult === undefined ) {
        console.log(`Failed to upload signed package to ${ghapi.details.owner}/${ghapi.details.repo}/${ghapi.details.tag}`);
        process.exit(1);
    }

    // Patch update file
    // https://github.com/uBlockOrigin/uBlock-issues/discussions/4075#discussioncomment-17923251
    const extensionId = await utils.shellExec(`openssl pkey \
        -in ${crxKeyPath} \
        -pubout \
        -outform DER | \
        sha256sum | \
        cut -c1-32 | \
        tr 0123456789abcdef abcdefghijklmnop`
    );
    let updateXml = updateXmlTemplate;
    updateXml = updateXml.replace('%extensionId%', extensionId);
    updateXml = updateXml.replace('%assetURL%', uploadResult.browser_download_url);
    updateXml = updateXml.replace('%assetVersion%', manifest.version);
    await fs.writeFile(crxupdatepath, updateXml);

    // Commit update file
    await utils.shellExec(`git add -u "${crxupdatepath}"`);
    const r = await utils.shellExec(`git status -s "${crxupdatepath}"`);
    if ( Boolean(r) === false ) {
        console.log(`git status -s "${crxupdatepath}" = ${r}`);
        return;
    }
    utils.shellExec(`
        git commit -m 'Make Chromium dev build auto-update' "${crxupdatepath}"
    `, { stdio: 'inherit' });
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

    // Upload to Chrome Web Store
    await publishToCWS({ assetInfo, manifest, packagePath });
    await publishToGithub({ assetInfo, manifest, packagePath });

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
