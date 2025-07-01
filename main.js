import axios from 'axios';
import crypto from 'crypto';
import nacl from 'tweetnacl';
import cron from "node-cron";
import { displayskw } from "./skw/displayskw.js";
import { logger } from "./skw/logger.js";
import { 
  privateKeys,
  Recepient,
  delay,
  rpcUrl,
  RandomAmount,
  randomdelay,
} from "./skw/config.js";

function privateKeyToOctAddress(base64PrivKey) {
  const privBytes = Buffer.from(base64PrivKey, 'base64');

  let keyPair;
  if (privBytes.length === 32) {
    keyPair = nacl.sign.keyPair.fromSeed(privBytes);
  } else if (privBytes.length === 64) {
    keyPair = nacl.sign.keyPair.fromSecretKey(privBytes);
  } else {
    throw new Error('Private key must be 32 or 64 bytes');
  }

  const publicKey = Buffer.from(keyPair.publicKey);
  const hashed = crypto.createHash('sha256').update(publicKey).digest();

  const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  let num = BigInt('0x' + hashed.toString('hex'));
  let encoded = '';

  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    encoded = BASE58_ALPHABET[Number(remainder)] + encoded;
  }

  for (let i = 0; i < hashed.length && hashed[i] === 0; i++) {
    encoded = '1' + encoded;
  }

  return 'oct' + encoded;
}

function getKeyPair(privateKey) {
  try {
    const privateKeyBytes = Buffer.from(privateKey, 'base64');

    if (privateKeyBytes.length === 32) {
      return nacl.sign.keyPair.fromSeed(privateKeyBytes);
    } else if (privateKeyBytes.length === 64) {
      return nacl.sign.keyPair.fromSecretKey(privateKeyBytes);
    } else {
      throw new Error(`Invalid key size: ${privateKeyBytes.length} bytes`);
    }
  } catch (err) {
    console.error('Error decoding private key:', err.message);
    throw new Error('Invalid private key format');
  }
}

async function postRPC(method, endpoint, data = null) {
  try {
    const url = `${rpcUrl}${endpoint}`;
    const config = {
      method,
      url,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Pempek-Lahat-Auto-TX/1.0'
      }
    };
    if (method === 'POST' && data) {
      config.data = data;
      config.headers['Content-Type'] = 'application/json';
    }

    const response = await axios(config);
    return {
      status: response.status,
      data: response.data,
      text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
    };
  } catch (error) {
    if (error.response) {
      return {
        status: error.response.status,
        data: error.response.data,
        text: error.response.statusText
      };
    }
    throw error;
  }
}

async function getCurrentNonce(address) {
  try {
    const [balanceResult, stagingResult] = await Promise.all([
      postRPC('GET', `/balance/${address}`),
      postRPC('GET', '/staging')
    ]);

    let nonce = 0;

    if (balanceResult.status === 200 && balanceResult.data) {
      nonce = parseInt(balanceResult.data.nonce || 0);
    }

    if (stagingResult.status === 200 && stagingResult.data) {
      const stagedTxs = stagingResult.data.staged_transactions || [];
      const ourTxs = stagedTxs.filter(tx => tx.from === address);
      if (ourTxs.length > 0) {
        const maxStagedNonce = Math.max(...ourTxs.map(tx => parseInt(tx.nonce || 0)));
        nonce = Math.max(nonce, maxStagedNonce);
      }
    }

    return nonce;
  } catch (err) {
    console.warn(`Error getting nonce for ${address}: ${err.message}`);
    return 0;
  }
}

async function getBalance(address) {
  try {
    const result = await postRPC('GET', `/balance/${address}`);

    if (result.status === 200 && result.data) {
      return parseFloat(result.data.balance || 0);
    }

    return 0;
  } catch (err) {
    console.warn(`Error getting balance: ${err.message}`);
    return 0;
  }
}

async function sendTransaction(wallet, toAddress, amount) {
  try {
    const nonce = await getCurrentNonce(wallet.address);
    const keyPair = getKeyPair(wallet.privateKey);
    const microOCT = 1_000_000;

    const transaction = {
      from: wallet.address,
      to_: toAddress,
      amount: String(Math.floor(amount * microOCT)),
      nonce: parseInt(nonce + 1),
      ou: amount < 1000 ? '1' : '3',
      timestamp: Date.now() / 1000 + Math.random() * 0.01
    };

    const message = JSON.stringify(transaction).replace(/\s+/g, '').replace(/,}/g, '}').replace(/,]/g, ']');
    const messageBytes = new TextEncoder().encode(message);
    const fullSignature = nacl.sign(messageBytes, keyPair.secretKey);
    const signature = fullSignature.slice(0, 64);
    const publicKey = Buffer.from(keyPair.publicKey).toString('base64');

    const finalTx = {
      ...transaction,
      signature: Buffer.from(signature).toString('base64'),
      public_key: publicKey
    };

    const result = await postRPC('POST', '/send-tx', finalTx);

    if (result.status === 200) {
      let txHash = '';

      if (result.data?.status === 'accepted') {
        txHash = result.data.tx_hash || '';
      } else if (result.text?.toLowerCase().startsWith('ok')) {
        const parts = result.text.split(' ');
        txHash = parts.at(-1) || '';
      }

      if (txHash) {
        return {
          success: true,
          hash: txHash
        };
      }
    }

    return {
      success: false,
      error: result.text || JSON.stringify(result.data)
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

async function sendtoAll(wallet) {
  try {
    for (const toAddress of Recepient) {

      if (toAddress === wallet.address) {
        continue;
      }

      logger.account(`Meproses Wallet: ${wallet.address}`);

      const amountToSend = RandomAmount(0.01, 0.1, 2);
      const balance = await getBalance(wallet.address);
      logger.balance(`Balance: ${balance.toFixed(4)} OCT`);

      if (balance < amountToSend) {
        logger.warn(`Balance too low. Skipping...`);
        continue;
      }

      logger.start(`Send ${amountToSend} OCT ke ${toAddress}`);

      const result = await sendTransaction(wallet, toAddress, amountToSend);
      logger.send(`Tx dikirim ->> ${rpcUrl}/tx/${result.hash}`);

      if (result.success) {
        logger.succes(`Transaksi Suksess`);
      } else {
        logger.fail(`Transaksi Gagal: ${result.error}`);
      }

      logger.info(`Menunggu Delay Sebelum Lanjut\n`);
      await delay(randomdelay());
    }
  } catch (err) {
    logger.fail(`Transaksi Gagal ${err.message || err}\n`);
  }
}

async function startBot() {
  displayskw();
  await delay(6000);
  console.clear();
  for (const base64Key of privateKeys) {
    const wallet = {
      address: privateKeyToOctAddress(base64Key),
      privateKey: base64Key
    };

    await sendtoAll(wallet);
    await delay(randomdelay());
  }
}

async function main() {
  cron.schedule('0 1 * * *', async () => {
    const date = new Date().toISOString().split('T')[0];
    await startBot();
    console.log();
    logger.info(`${date} Cron AKTIF`);
    logger.info('Besok Jam 08:00 WIB Autobot Akan Run');
  });

  const today = new Date().toISOString().split('T')[0];
  await startBot();
  console.log();
  logger.info(`${today} Cron AKTIF`);
  logger.info('Besok Jam 08:00 WIB Autobot Akan Run');
}

main();
