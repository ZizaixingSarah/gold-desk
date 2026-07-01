import { getDashboardPayload } from "../server.js";

export default async function handler(req, res) {
  try {
    const force = req.query?.force === "1";
    const payload = await getDashboardPayload(force);
    res.status(200).json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
}
