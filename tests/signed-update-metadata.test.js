const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {canonicalPayload, signMetadata} = require('../utils/signedUpdateMetadata');

test('signed metadata verifies; changed policy and different key fail', () => {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength:2048});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'update-signing-fixture-'));
  try {
    const keyFile=path.join(dir,'test-key.pem');
    fs.writeFileSync(keyFile,privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
    const signed=signMetadata({latestVersion:'1.0.16', latestBuildNumber:38, fileSizeBytes:100, releaseNotes:'मराठी',forceUpdate:false},keyFile);
    const signature=Buffer.from(signed.metadataSignature,'base64');
    const verify = value => crypto.verify('RSA-SHA256',Buffer.from(canonicalPayload(value)),publicKey,signature);
    assert.equal(verify(signed),true);
    assert.equal(verify({...signed,forceUpdate:true}),false);
    assert.equal(verify({...signed,latestBuildNumber:39}),false);
    assert.equal(signed.signatureAlgorithm,'RSA-SHA256');
    assert.equal(signed.schemaVersion, 2);
    assert.equal(signed.channel, 'production_private');
    assert.equal(signed.releaseSequence, 38);
    assert.equal(Date.parse(signed.expiresAt) - Date.parse(signed.issuedAt), 6*60*60*1000);
    const unknown = crypto.generateKeyPairSync('rsa', {modulusLength:2048}).publicKey;
    assert.equal(crypto.verify('RSA-SHA256', Buffer.from(canonicalPayload(signed)), unknown, signature), false);
    assert.equal(verify({...signed, channel:'internal_qa'}), false);
    assert.equal(verify({...signed, expiresAt:'2099-01-01T00:00:00.000Z'}), false);
    fs.chmodSync(keyFile,0o644);
    assert.throws(()=>signMetadata({latestBuildNumber:38,fileSizeBytes:100},keyFile),/PERMISSIONS/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('canonical payload matches Dart flat sorted JSON',()=> {
  assert.equal(canonicalPayload({z:2,a:'मराठी',metadataSignature:'ignored',signatureAlgorithm:'RSA-SHA256'}),'{"a":"मराठी","z":2}');
  assert.throws(()=>canonicalPayload({a:{b:1}}));
});
test('legacy server response stays compatible; configured missing key fails closed',()=> {
  const original={latestVersion:'1.0.16'};
  assert.equal(signMetadata(original,undefined),original);
  assert.throws(()=>signMetadata(original,'/nonexistent/qa-key-fixture.pem'));
});
