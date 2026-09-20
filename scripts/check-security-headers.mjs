#!/usr/bin/env node

const url = process.argv[2] ?? "https://pubchat.org";

const requiredHeaders = [
  "content-security-policy",
  "cross-origin-opener-policy",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
];

const response = await fetch(url, {
  method: "GET",
  redirect: "manual",
});

console.log(`${response.status} ${response.statusText} ${url}`);

let missing = 0;

for (const name of requiredHeaders) {
  const value = response.headers.get(name);
  if (value) {
    console.log(`ok      ${name}: ${value}`);
  } else {
    missing++;
    console.log(`missing ${name}`);
  }
}

if (missing > 0) {
  process.exitCode = 1;
}
