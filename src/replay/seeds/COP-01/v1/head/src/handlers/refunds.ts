import type { Request, Response } from "express";
import { db } from "../db.js";

export async function createRefund(req: Request, res: Response) {
  const body = req.body;
  if (!body.customerId || !body.items) {
    res.status(400).json({ error: "invalid body" });
    return;
  }
  if (typeof body.customerId !== "string") {
    res.status(400).json({ error: "invalid customer" });
    return;
  }
  const saved = await db.insert("refunds", body);
  res.status(201).json(body);
}
