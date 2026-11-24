import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseShareBaseUrl, isUnencryptedRemoteUrl, shareQrMatchesLink } from '../src/lib/shareUrl.js';

test('share links preserve the remote HTTPS or VPN origin, and only show matching QR codes', () => {
  const lan = 'http://192.168.1.9:3840';
  assert.equal(chooseShareBaseUrl('https://photos.example', lan), 'https://photos.example');
  assert.equal(chooseShareBaseUrl('https://localhost:3840', lan), 'https://localhost:3840');
  assert.equal(chooseShareBaseUrl('https://localhost:3840', lan, 'https://photos.example'), 'https://photos.example');
  assert.equal(chooseShareBaseUrl('http://localhost:3840', lan, 'https://photos.example'), 'https://photos.example');
  assert.equal(chooseShareBaseUrl('https://remote.example', lan, 'https://photos.example'), 'https://remote.example');
  assert.equal(chooseShareBaseUrl('http://100.70.1.2:3840', lan), 'http://100.70.1.2:3840');
  assert.equal(chooseShareBaseUrl('http://localhost:3840', lan), lan);
  assert.equal(chooseShareBaseUrl('http://[::1]:3840', null), 'http://[::1]:3840');
  assert.equal(shareQrMatchesLink('https://photos.example', lan), false);
  assert.equal(shareQrMatchesLink(lan, lan), true);
  assert.equal(shareQrMatchesLink(lan, null), false);
  assert.equal(shareQrMatchesLink(lan, 'invalid'), false);
  assert.equal(isUnencryptedRemoteUrl(lan), true);
  assert.equal(isUnencryptedRemoteUrl('http://localhost:3840'), false);
  assert.equal(isUnencryptedRemoteUrl('https://photos.example'), false);
});
