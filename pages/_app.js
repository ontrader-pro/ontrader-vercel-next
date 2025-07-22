// pages/_app.js

// Removed SpeedInsights import to avoid build errors
// If you need global CSS, create a file at styles/globals.css and import it here

export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
