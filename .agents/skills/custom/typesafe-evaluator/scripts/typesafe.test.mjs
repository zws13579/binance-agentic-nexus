import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTypeSafeConfig } from './typesafe.mjs';

const endpointOf = (env, runtimeEnv) => resolveTypeSafeConfig(env, runtimeEnv).endpoint;

test('未配置地址时使用官方地址', () => {
  assert.equal(endpointOf({}), 'https://api.typesafe.ai/v1/systemone');
});

test('TYPESAFE_ENDPOINT 优先于 TYPESAFE_BASE_URL', () => {
  assert.equal(
    endpointOf({ TYPESAFE_ENDPOINT: 'https://x.example/custom', TYPESAFE_BASE_URL: 'https://y.example' }),
    'https://x.example/custom'
  );
});

test('只填域名时补 /v1/systemone，含末尾斜杠', () => {
  assert.equal(endpointOf({ TYPESAFE_BASE_URL: 'https://api.typesafe.ai' }), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(endpointOf({ TYPESAFE_BASE_URL: 'https://api.typesafe.ai/' }), 'https://api.typesafe.ai/v1/systemone');
});

test('base 已含 /v1 时保留并追加 /systemone', () => {
  assert.equal(endpointOf({ TYPESAFE_BASE_URL: 'https://api.typesafe.ai/v1' }), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(endpointOf({ TYPESAFE_BASE_URL: 'https://api.typesafe.ai/v1/' }), 'https://api.typesafe.ai/v1/systemone');
});

test('带自定义路径的网关地址保持原行为，只追加 /systemone', () => {
  assert.equal(endpointOf({ TYPESAFE_BASE_URL: 'https://gw.example/proxy' }), 'https://gw.example/proxy/systemone');
});

test('无法解析为 URL 时保持原行为', () => {
  assert.equal(endpointOf({ TYPESAFE_BASE_URL: 'not a url' }), 'not a url/systemone');
});

test('进程变量优先于文件值', () => {
  assert.equal(
    endpointOf({ TYPESAFE_BASE_URL: 'https://file.example' }, { TYPESAFE_BASE_URL: 'https://proc.example' }),
    'https://proc.example/v1/systemone'
  );
});
