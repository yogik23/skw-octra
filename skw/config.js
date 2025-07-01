import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const rpcUrl = 'https://octra.network';

export const privateKeys = fs.readFileSync(path.join(__dirname, "..privatekey.txt"), "utf-8")
  .split("\n")
  .map(k => k.trim())
  .filter(k => k.length > 0);

export const Recepient = fs.readFileSync(path.join(__dirname, "..recepient.txt"), "utf-8")
  .split("\n")
  .map(k => k.trim())
  .filter(k => k.length > 0);

export function RandomAmount(min, max, decimalPlaces) {
  return (Math.random() * (max - min) + min).toFixed(decimalPlaces);
}

export function randomdelay(min = 10000, max = 20000) {
  return Math.floor(Math.random() * (max - min) + min);
}
