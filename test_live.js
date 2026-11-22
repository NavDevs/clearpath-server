const https = require('https');

async function testLive() {
  try {
    // 1. Register a user
    const regRes = await req('https://clearpath-server.onrender.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ name: 'Roadly Tester', phone: '9988776655', password: 'password123' }));

    console.log('Register response:', regRes.status, regRes.body);
    const parsed = JSON.parse(regRes.body);
    const userId = parsed.user ? parsed.user.id : null;

    if (!userId) {
      console.log('Trying login instead...');
      const loginRes = await req('https://clearpath-server.onrender.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ phone: '9988776655', password: 'password123' }));
      console.log('Login response:', loginRes.status, loginRes.body);
      userId = JSON.parse(loginRes.body).user.id;
    }

    // 2. Submit report without photo
    const boundary = '----WebKitFormBoundaryTest12345';
    let body = '';
    body += `--${boundary}\r\nContent-Disposition: form-data; name="user_id"\r\n\r\n${userId}\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\npothole\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nTest pothole\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="address"\r\n\r\nTest street\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="points"\r\n\r\n10\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="latitude"\r\n\r\n12.9716\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="longitude"\r\n\r\n77.5946\r\n`;
    body += `--${boundary}--\r\n`;

    const subRes = await req('https://clearpath-server.onrender.com/api/reports', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);

    console.log('Submit response status:', subRes.status);
    console.log('Submit response body:', subRes.body);

  } catch (e) {
    console.error('Error:', e);
  }
}

function req(url, options, data) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, options, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

testLive();
