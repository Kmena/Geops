import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveLocalMdmGrant } from '../mdm-oauth-secret-export.mjs';

test('local grant export writes all secrets once without overwriting an existing grant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geops-mdm-grant-test-'));
  const config = { clientId: 'EXAMPLE_CLIENT', clientSecret: 'EXAMPLE_SECRET' };
  try {
    await saveLocalMdmGrant(directory, config, 'EXAMPLE_REFRESH');
    assert.equal(await readFile(join(directory, 'mdm_refresh_token'), 'utf8'), 'EXAMPLE_REFRESH');
    await assert.rejects(saveLocalMdmGrant(directory, config, 'ANOTHER_REFRESH'), {
      message: 'mdm_grant_export_failed',
    });
    assert.equal(await readFile(join(directory, 'mdm_client_id'), 'utf8'), 'EXAMPLE_CLIENT');
    assert.equal(await readFile(join(directory, 'mdm_refresh_token'), 'utf8'), 'EXAMPLE_REFRESH');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local grant export refuses a partial destination and leaves prior data untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geops-mdm-grant-test-'));
  try {
    await writeFile(join(directory, 'mdm_client_secret'), 'EXISTING_SECRET');
    await assert.rejects(
      saveLocalMdmGrant(
        directory,
        { clientId: 'EXAMPLE_CLIENT', clientSecret: 'NEW_SECRET' },
        'EXAMPLE_REFRESH',
      ),
      { message: 'mdm_grant_export_failed' },
    );
    assert.equal(await readFile(join(directory, 'mdm_client_secret'), 'utf8'), 'EXISTING_SECRET');
    await assert.rejects(readFile(join(directory, 'mdm_client_id'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
