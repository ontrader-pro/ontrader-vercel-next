// pages/_app.js
import '../styles/globals.css';
import { SpeedInsights } from '@vercel/speed-insights';

function MyApp({ Component, pageProps }) {
  return (
    <>
      <Component {...pageProps} />
      <SpeedInsights />
    </>
  );
}

export default MyApp;
