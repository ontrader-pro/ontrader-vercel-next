async function indexDataHandler(req, res) {
  try {
    // todo tu código actual dentro del handler
  } catch (error) {
    console.error('❌ ERROR GLOBAL:', error.message);
    res.status(500).json({ error: error.message });
  }
}

module.exports = indexDataHandler;
