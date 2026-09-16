import 'dotenv/config';

process.env.QLIK_CLOUD_LIVE_PROBE = 'G5';
process.env.QLIK_CLOUD_LIVE_RETAIN_OBJECT = 'true';

void import('./cloudAdapterProbe.js');
