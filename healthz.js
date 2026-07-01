import { healthPayload } from "../server.js";

export default function handler(req, res) {
  res.status(200).json(healthPayload());
}
