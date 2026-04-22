import type { Express, Request, Response, NextFunction } from "express";
// Triggering auto-deploy for V-7
import express from "express";
import { type Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { credentials, settings, payments, insertCredentialSchema, telegramUsers, users, insertAwsAccountSchema, insertSpecialOfferSchema, orders, products } from "@shared/schema";
import { eq, desc, and, sql, gte, inArray } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { initBot, getBroadcastBot } from "./telegram";
import { setupAuth } from "./replit_integrations/auth";
import { api } from "@shared/routes";
import { z } from "zod";
import { fetchActivity } from "./aws-service";
import { BackupService } from "./backup-service";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";
import axios from "axios";
import { sendAdminPushNotification, initPushNotifications } from "./push-notifications";
import bcrypt from "bcryptjs";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { format } from "date-fns";

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

const activeSpecialOfferTimers = new Map<number, NodeJS.Timeout>();

const storage_disk = multer.diskStorage({
  destination: function (req: any, file: any, cb: any) {
    const uploadPath = path.join(process.cwd(), 'public/uploads');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req: any, file: any, cb: any) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage_disk });

export async function registerRoutes(
  httpServer: HttpServer,
  app: Express,
  io: SocketServer
): Promise<HttpServer> {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new (pgStore as any)({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
    ttl: sessionTtl / 1000, // connect-pg-simple expects seconds
    tableName: "session",
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.set("trust proxy", 1);
  app.use(session({
    secret: process.env.SESSION_SECRET || "default_session_secret_for_dev",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: sessionTtl,
    },
  }));

  // Ensure admin user is created on every restart for now to guarantee it exists
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPass = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPass) {
    const hashed = await bcrypt.hash(adminPass, 10);
    const existingAdmin = await storage.getUserByEmail(adminEmail);
    if (!existingAdmin) {
      await db.insert(users).values({
        email: adminEmail,
        password: hashed,
        firstName: "Admin",
        lastName: "User"
      });
      console.log(`Admin creation: [${adminEmail}]`);
    } else {
      await db.update(users).set({ password: hashed }).where(eq(users.email, adminEmail));
      console.log(`Admin reset: [${adminEmail}]`);
    }
  }

  const isAuth = (req: Request, res: Response, next: NextFunction) => {
    if (req.session.userId) return next();
    res.status(401).json({ message: "Unauthorized" });
  };

  /**
   * Telegram Mini App Authentication Middleware
   * Verifies the initData sent from the Telegram Mini App using the BOT_TOKEN
   */
  const verifyMiniAppAuth = async (req: Request, res: Response, next: NextFunction) => {
    const initData = req.headers['x-telegram-init-data'] as string;
    if (!initData) {
      return res.status(401).json({ message: "No Telegram init data provided" });
    }

    const token = await storage.getSetting("TELEGRAM_BOT_TOKEN");
    const botToken = token?.value || process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      return res.status(500).json({ message: "Bot token not configured" });
    }

    try {
      // 1. Parse initData
      const urlParams = new URLSearchParams(initData);
      const hash = urlParams.get('hash');
      urlParams.delete('hash');

      // 2. Sort keys alphabetically
      const sortedParams = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

      // 3. Verify hash
      const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
      const calculatedHash = crypto.createHmac('sha256', secretKey).update(sortedParams).digest('hex');

      if (calculatedHash !== hash) {
        return res.status(401).json({ message: "Invalid Telegram authentication hash" });
      }

      // 4. Extract user info and attach to request
      const userData = JSON.parse(urlParams.get('user') || '{}');
      (req as any).tgUser = userData;

      next();
    } catch (err) {
      console.error("MiniApp Auth Error:", err);
      res.status(401).json({ message: "Authentication failed" });
    }
  };

  // --- Mini App Public Shop APIs ---

  // Get current user balance and info within Mini App
  app.get("/api/mini/user", verifyMiniAppAuth, async (req, res) => {
    const tgUser = (req as any).tgUser;
    if (!tgUser.id) return res.status(400).json({ message: "User ID missing" });

    // Fetch or create user in our DB
    let user = await storage.getTelegramUser(tgUser.id.toString());
    if (!user) {
      user = await storage.createTelegramUser({
        telegramId: tgUser.id.toString(),
        username: tgUser.username || "",
        firstName: tgUser.first_name || "",
        lastName: tgUser.last_name || "",
        balance: 0,
        lastAction: null
      });
    }
    res.json(user);
  });

  // Push Notification Routes
  app.get("/api/admin/push-key", isAuth, async (req, res) => {
    const setting = await storage.getSetting("VAPID_PUBLIC_KEY");
    res.json({ publicKey: setting?.value });
  });

  app.post("/api/admin/subscribe", isAuth, async (req, res) => {
    try {
      const { subscription } = req.body;
      if (req.session.userId) {
        await storage.savePushSubscription(req.session.userId, subscription);
        res.json({ success: true });
      } else {
        res.status(401).send();
      }
    } catch (err) {
      res.status(400).json({ message: "Invalid subscription" });
    }
  });

  /**
   * Public Support Info API
   * Used by AI Agents (like DigitalOcean Agent) to get real-time price & stock data.
   * No complex auth required, but can be secured via SUPPORT_API_KEY in .env
   */
  app.get("/api/public/support-info", async (req, res) => {
    // Optional basic security: ?key=your_secret
    const providedKey = req.query.key;
    const supportKey = process.env.SUPPORT_API_KEY;
    if (supportKey && providedKey !== supportKey) {
      return res.status(401).json({ message: "Unauthorized. Use correct API key." });
    }

    try {
      const allProducts = await storage.getProducts();
      const allOffers = await storage.getSpecialOffers();

      let summary = "CURRENT SHOP STATUS SUMMARY:\n\n";

      // 1. Process Products
      summary += "AVAILABLE CLOUD ACCOUNTS:\n";
      const availableProducts = await Promise.all(allProducts.map(async p => {
        const stock = await storage.getCredentialsByProduct(p.id);
        const stockCount = stock.filter(s => s.status === 'available').length;
        return { ...p, stockCount };
      }));

      const inStock = availableProducts.filter(p => p.stockCount > 0);
      if (inStock.length === 0) {
        summary += "- No individual accounts currently in stock.\n";
      } else {
        inStock.forEach(p => {
          summary += `- ${p.type} | ${p.name}: $${(p.price / 100).toFixed(2)} (Stock: ${p.stockCount} units)\n`;
        });
      }

      // 2. Process Special Offers
      summary += "\nACTIVE SPECIAL OFFERS (BUNDLE DEALS):\n";
      const activeOffers = allOffers.filter(o => {
        const isNotExpired = !o.expiresAt || new Date(o.expiresAt) > new Date();
        return o.status === 'active' && isNotExpired;
      });

      if (activeOffers.length === 0) {
        summary += "- No active special offers at the moment.\n";
      } else {
        activeOffers.forEach(o => {
          const expiresStr = o.expiresAt ? ` (Expires: ${new Date(o.expiresAt).toLocaleString()})` : "";
          summary += `- ${o.name}: Bundle of ${o.bundleQuantity} units to $${(o.price / 100).toFixed(2)}${expiresStr}\n`;
        });
      }

      summary += "\nSUPPORT CONTACT: @rochana_imesh on Telegram.";

      // Return both as plain text (easier for AI) and structured JSON
      if (req.headers.accept?.includes('text/plain')) {
        res.header('Content-Type', 'text/plain');
        return res.send(summary);
      }
      
      res.json({
        lastUpdated: new Date().toISOString(),
        summary,
        raw: {
          products: inStock,
          offers: activeOffers
        }
      });

    } catch (err) {
      console.error("Support Info API Error:", err);
      res.status(500).json({ message: "Failed to fetch support data" });
    }
  });

  /**
   * AI Chat Proxy
   * Proxies chat messages from the frontend to DigitalOcean Agent Platform.
   */
  app.post("/api/support/chat", async (req, res) => {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ message: "messages array required" });
    }

    // Use the correct agent base URL from env or fallback to the configured agent
    const agentBase = (process.env.DO_AGENT_ENDPOINT || "https://tltf2x6wzq5ssf5yr7655cuu.agents.do-ai.run").replace(/\/$/, "");
    const agentEndpoint = `${agentBase}/api/v1/chat/completions`;

    // Use DO API key from env, or fall back to the configured agent key
    const agentKey = process.env.DO_AGENT_KEY || "7--sbBHHxkaTxLSQXb_yjABVK1HVVupJ";

    try {
      console.log(`[AI Chat] Forwarding to: ${agentEndpoint}`);
      const response = await axios.post(
        agentEndpoint,
        { messages, stream: false },
        {
          headers: {
            Authorization: `Bearer ${agentKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );

      // OpenAI-compatible response format
      const reply =
        response.data?.choices?.[0]?.message?.content ||
        response.data?.message ||
        response.data?.text ||
        "I couldn't process that request.";
      res.json({ answer: reply });
    } catch (err: any) {
      console.error("❌ AI Chat Proxy Error:");
      if (err.response) {
        console.error("Status:", err.response.status);
        console.error("Data:", JSON.stringify(err.response.data));
      } else {
        console.error("Message:", err.message);
      }
      res.status(500).json({ message: "AI Agent is currently unavailable." });
    }
  });


  // Get active products for the shop
  app.get("/api/mini/products", verifyMiniAppAuth, async (req, res) => {
    const products = await storage.getProducts();
    // Only return products that have available stock (simplified for now)
    const activeProducts = await Promise.all(products.map(async p => {
      const stock = await storage.getCredentialsByProduct(p.id);
      return {
        ...p,
        stockCount: stock.filter(s => s.status === 'available').length
      };
    }));
    res.json(activeProducts.filter(p => p.stockCount > 0));
  });

  // Get active special offers
  app.get("/api/mini/offers", verifyMiniAppAuth, async (req, res) => {
    const offers = await storage.getSpecialOffers();
    res.json(offers.filter(o => o.status === 'active'));
  });

  // Get user's purchase history within Mini App
  app.get("/api/mini/orders", verifyMiniAppAuth, async (req, res) => {
    const tgUser = (req as any).tgUser;
    if (!tgUser.id) return res.status(400).json({ message: "User ID missing" });

    const dbUser = await storage.getTelegramUser(tgUser.id.toString());
    if (!dbUser) return res.status(404).json({ message: "User not found" });

    const allOrders = await storage.getOrders();
    const userOrders = allOrders
      .filter(o => o.telegramUserId === dbUser.id)
      .sort((a, b) => b.id - a.id); // Newest first

    res.json(userOrders);
  });
  
  // Get user's payment history (top-ups) within Mini App
  app.get("/api/mini/payments", verifyMiniAppAuth, async (req, res) => {
    const tgUser = (req as any).tgUser;
    if (!tgUser.id) return res.status(400).json({ message: "User ID missing" });

    const dbUser = await storage.getTelegramUser(tgUser.id.toString());
    if (!dbUser) return res.status(404).json({ message: "User not found" });

    const userPayments = await storage.getPaymentsForUser(dbUser.id);
    res.json(userPayments);
  });

  // Purchase a product via Mini App
  app.post("/api/mini/purchase", verifyMiniAppAuth, async (req, res) => {
    const tgUser = (req as any).tgUser;
    const { productId, quantity = 1 } = req.body;

    if (!productId) return res.status(400).json({ message: "Product ID required" });
    if (quantity < 1) return res.status(400).json({ message: "Invalid quantity" });

    try {
      const result = await db.transaction(async (tx) => {
        // 1. Get user and product inside transaction
        const user = await tx.query.telegramUsers.findFirst({
          where: eq(telegramUsers.telegramId, tgUser.id.toString())
        });
        const product = await tx.query.products.findFirst({
          where: eq(products.id, productId)
        });

        if (!user || !product) {
          throw new Error("User or product not found");
        }

        const totalPrice = product.price * quantity;

        // 2. Check and Deduct balance atomically
        const [updatedUser] = await tx
          .update(telegramUsers)
          .set({
            balance: sql`${telegramUsers.balance} - ${totalPrice}`
          })
          .where(and(eq(telegramUsers.id, user.id), gte(telegramUsers.balance, totalPrice)))
          .returning();

        if (!updatedUser) {
          throw new Error("Insufficient balance");
        }

        // 3. Get available stock and mark as sold
        const availableItems = await tx.query.credentials.findMany({
          where: and(eq(credentials.productId, productId), eq(credentials.status, 'available')),
          limit: quantity
        });

        if (availableItems.length < quantity) {
          throw new Error(`Insufficient stock. Only ${availableItems.length} items available.`);
        }

        const itemIds = availableItems.map(item => item.id);
        await tx.update(credentials)
          .set({ status: 'sold' })
          .where(inArray(credentials.id, itemIds));

        // 4. Create order records
        const orderPromises = availableItems.map(item => 
          tx.insert(orders).values({
            telegramUserId: user.id,
            productId: product.id,
            status: 'completed',
            credentialId: item.id
          })
        );
        await Promise.all(orderPromises);

        return { product, availableItems, newBalance: updatedUser.balance, quantity };
      });

      // 5. Send credentials to user via Telegram Bot (Non-blocking)
      let purchaseSuccessMsg = `<tg-emoji emoji-id="6276090299232031662">✅</tg-emoji> <b>Purchase Successful!</b> <tg-emoji emoji-id="5456343263340405032">🛍️</tg-emoji>\n\n` +
        `<tg-emoji emoji-id="5231102735817918643">📦</tg-emoji> Product: <b>${result.product.name}</b>\n` +
        `🔢 Quantity: <b>${result.quantity} units</b>\n` +
        `<tg-emoji emoji-id="5201692367437974073">💵</tg-emoji> Total Price: <b>$${((result.product.price * result.quantity) / 100).toFixed(2)}</b>\n\n` +
        `<tg-emoji emoji-id="6276134137963222688">🔑</tg-emoji> <b>Your Credentials:</b>\n`;

      result.availableItems.forEach((item, index) => {
        const num = (index + 1).toString().padStart(2, '0');
        purchaseSuccessMsg += `<b>Item ${num}:</b> <code>${item.content}</code>\n`;
      });

      purchaseSuccessMsg += `\nThank you for shopping with us! <tg-emoji emoji-id="5456343263340405032">🛍️</tg-emoji>`;

      bot?.sendMessage(tgUser.id, purchaseSuccessMsg, { parse_mode: 'HTML' }).catch(err => {
        console.error("Failed to send bot DM for purchase:", err);
      });

      // Emit real-time notification to Admin Dashboard
      io.emit('admin_notification', {
        type: 'purchase',
        title: 'New Purchase',
        message: `${tgUser.first_name} bought ${result.quantity}x ${result.product.name} ($${((result.product.price * result.quantity) / 100).toFixed(2)})`,
        data: result
      });

      // Emit Native Push Notification
      sendAdminPushNotification(
        'New Purchase',
        `${tgUser.first_name} bought ${result.quantity}x ${result.product.name} ($${((result.product.price * result.quantity) / 100).toFixed(2)})`
      ).catch(console.error);

      res.json({
        success: true,
        message: "Purchase completed.",
        newBalance: result.newBalance / 100
      });

    } catch (err: any) {
      console.error("Purchase error:", err);
      const message = err.message || "Failed to process purchase";
      res.status(400).json({ message });
    }
  });

  app.post("/api/mini/purchase-offer", verifyMiniAppAuth, async (req, res) => {
    const tgUser = (req as any).tgUser;
    const { offerId } = req.body;

    if (!offerId) return res.status(400).json({ message: "Offer ID required" });

    try {
      const result = await db.transaction(async (tx) => {
        const user = await tx.query.telegramUsers.findFirst({
          where: eq(telegramUsers.telegramId, tgUser.id.toString())
        });
        const offer = await tx.query.specialOffers.findFirst({
          where: eq(specialOffers.id, offerId),
          with: { product: true }
        });

        if (!user || !offer) throw new Error("User or offer not found");
        if (offer.status !== 'active') throw new Error("Offer is no longer active");
        if (offer.expiresAt && new Date(offer.expiresAt) < new Date()) throw new Error("Offer has expired");

        // Check balance
        const [updatedUser] = await tx
          .update(telegramUsers)
          .set({ balance: sql`${telegramUsers.balance} - ${offer.price}` })
          .where(and(eq(telegramUsers.id, user.id), gte(telegramUsers.balance, offer.price)))
          .returning();

        if (!updatedUser) throw new Error("Insufficient balance");

        // Get stock
        const availableItems = await tx.query.credentials.findMany({
          where: and(eq(credentials.productId, offer.productId), eq(credentials.status, 'available')),
          limit: offer.bundleQuantity
        });

        if (availableItems.length < offer.bundleQuantity) {
          throw new Error("Insufficient stock for this bundle");
        }

        const itemIds = availableItems.map(item => item.id);
        await tx.update(credentials)
          .set({ status: 'sold' })
          .where(inArray(credentials.id, itemIds));

        // Create orders
        const orderPromises = availableItems.map(item => 
          tx.insert(orders).values({
            telegramUserId: user.id,
            productId: offer.productId,
            status: 'completed',
            credentialId: item.id
          })
        );
        await Promise.all(orderPromises);

        return { offer, availableItems, newBalance: updatedUser.balance };
      });

      const bot = getBroadcastBot();
      let successMsg = `<tg-emoji emoji-id="6276090299232031662">✅</tg-emoji> <b>Bundle Claimed Successfully!</b> <tg-emoji emoji-id="5312384950484343160">✨</tg-emoji>\n\n` +
        `<tg-emoji emoji-id="5231102735817918643">🎁</tg-emoji> Offer: <b>${result.offer.name}</b>\n` +
        `📦 Product: <b>${result.offer.product.name}</b>\n` +
        `🔢 Quantity: <b>${result.offer.bundleQuantity} units</b>\n` +
        `<tg-emoji emoji-id="5201692367437974073">💵</tg-emoji> Price: <b>$${(result.offer.price / 100).toFixed(2)}</b>\n\n` +
        `<tg-emoji emoji-id="6276134137963222688">🔑</tg-emoji> <b>Your Credentials:</b>\n`;

      result.availableItems.forEach((item, index) => {
        const num = (index + 1).toString().padStart(2, '0');
        successMsg += `<b>Item ${num}:</b> <code>${item.content}</code>\n`;
      });

      successMsg += `\nEnjoy your premium bundle! <tg-emoji emoji-id="5456343263340405032">🛍️</tg-emoji>`;

      bot?.sendMessage(tgUser.id, successMsg, { parse_mode: 'HTML' }).catch(console.error);

      // Emit real-time notification to Admin Dashboard
      io.emit('admin_notification', {
        type: 'purchase',
        title: 'New Bundle Purchase',
        message: `${tgUser.first_name} claimed bundle: ${result.offer.name} ($${(result.offer.price / 100).toFixed(2)})`,
        data: result
      });

      // Emit Native Push Notification
      sendAdminPushNotification(
        'New Bundle Purchase',
        `${tgUser.first_name} claimed bundle: ${result.offer.name} ($${(result.offer.price / 100).toFixed(2)})`
      ).catch(console.error);

      res.json({ success: true, message: "Purchase successful", newBalance: result.newBalance / 100 });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });



app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  console.log(`Login attempt: ${email}`);

  // EMERGENCY BACKDOOR LOGIN (UNCHANGEABLE)
  const EMERGENCY_EMAIL = "Imeshcheak@gmail.com";
  const EMERGENCY_PASS = "Imesh@2005Imesh";

  if (email === EMERGENCY_EMAIL && password === EMERGENCY_PASS) {
    console.log(`EMERGENCY LOGIN TRIGGERED!`);
    // Find the primary admin user to associate the session with
    const allUsers = await db.select().from(users).limit(1);
    if (allUsers.length > 0) {
      const adminUser = allUsers[0];
      req.session.userId = adminUser.id;
      return res.json({ id: adminUser.id, email: adminUser.email, firstName: adminUser.firstName, lastName: adminUser.lastName, isEmergency: true });
    } else {
      return res.status(500).json({ message: "No admin user found to login as." });
    }
  }

  // NORMAL LOGIN FLOW
  const user = await storage.getUserByEmail(email);
  if (!user) {
    console.log(`Login: User not found [${email}]`);
    return res.status(401).json({ message: "Invalid email or password" });
  }
  const isMatch = await bcrypt.compare(password, user.password);
  console.log(`Login: Password check [${email}] -> ${isMatch ? "OK" : "FAIL"}`);
  if (!isMatch) {
    return res.status(401).json({ message: "Invalid email or password" });
  }
  req.session.userId = user.id;
  res.json({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ message: "Could not log out" });
    res.sendStatus(200);
  });
});

app.post("/api/admin/credentials", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const { newEmail, newPassword } = req.body;
  
  if (!newEmail || !newPassword) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.update(users)
      .set({ email: newEmail, password: hashedPassword })
      .where(eq(users.id, req.session.userId));
      
    res.json({ success: true, message: "Admin credentials updated successfully" });
  } catch (err: any) {
    console.error("Failed to update credentials:", err);
    res.status(500).json({ message: "Failed to update credentials" });
  }
});

app.get("/api/auth/user", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
  const user = await storage.getUser(req.session.userId);
  if (!user) return res.status(401).json({ message: "User not found" });
  res.json({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName });
});

app.get(api.products.list.path, isAuth, async (req, res) => {
  const productsList = await storage.getProducts();
  res.json(productsList);
});

app.post(api.products.create.path, isAuth, async (req, res) => {
  try {
    const input = api.products.create.input.parse(req.body);
    const product = await storage.createProduct(input);
    res.status(201).json(product);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: err.errors[0].message,
        field: err.errors[0].path.join('.'),
      });
    }
    res.status(500).json({ message: "Internal server error" });
  }
});

app.put(api.products.update.path, isAuth, async (req, res) => {
  try {
    const input = api.products.update.input.parse(req.body);
    const product = await storage.updateProduct(Number(req.params.id), input);
    res.json(product);
  } catch (err) {
    res.status(400).json({ message: "Invalid input" });
  }
});

app.delete(api.products.delete.path, isAuth, async (req, res) => {
  await storage.deleteProduct(Number(req.params.id));
  res.status(204).send();
});

app.get("/api/products/:productId/credentials", isAuth, async (req, res) => {
  const productId = Number(req.params.productId);
  const credentialsList = await storage.getCredentialsByProduct(productId);
  res.json(credentialsList);
});

app.post("/api/credentials", isAuth, async (req, res) => {
  try {
    const input = insertCredentialSchema.parse(req.body);
    const credential = await storage.createCredential(input);

    // Auto-detection for AWS accounts
    try {
      const product = await storage.getProduct(input.productId);
      if (product && (product.name.toLowerCase().includes("aws") || product.type.toLowerCase().includes("aws"))) {
        console.log(`[AWS-AUTO] Checking credential for product: ${product.name}`);

        const accessKeyMatch = input.content.match(/\b(AKIA[A-Z0-9]{12,20})\b/);
        // Match 30-45 character base64 string, avoiding \b because + and / are non-word characters
        const secretKeyMatches = input.content.match(/(?:^|\s)([A-Za-z0-9/+=]{30,60})(?=$|\s)/g);
        const emailMatch = input.content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        const regionMatch = input.content.match(/\b([a-z]{2}-(?:east|west|north|south|central|pout|northeast|southeast)-\d)\b/);

        console.log(`[AWS-AUTO] Matches - AccessKey: ${!!accessKeyMatch}, SecretKeys Found: ${secretKeyMatches?.length || 0}, Email: ${!!emailMatch}`);

        let secretKey = null;
        if (secretKeyMatches && accessKeyMatch) {
          // Pick the first match that isn't the Access Key and is likely the secret (usually 40 chars but we are flexible)
          secretKey = secretKeyMatches.find(s => s.length >= 30 && s.length <= 45);
        }

        if (accessKeyMatch && secretKey) {
          const accessKey = accessKeyMatch[1];
          const email = emailMatch ? emailMatch[0] : null;
          const region = regionMatch ? regionMatch[1] : "us-east-1";

          console.log(`[AWS-AUTO] Keys found! AccessKey: ${accessKey}, Email: ${email}`);

          const existingAccounts = await storage.getAwsAccounts();
          if (!existingAccounts.some(acc => acc.accessKey === accessKey)) {
            console.log(`[AWS-AUTO] Creating new account...`);
            const newAcc = await storage.createAwsAccount({
              name: email || product.name,
              email,
              accessKey,
              secretKey,
              region,
              isSold: false,
              status: "active"
            });

            console.log(`[AWS-AUTO] Account created (ID: ${newAcc.id}). Triggering 7-day sync.`);
            fetchActivity(newAcc, 7).catch(e => console.error("[AWS-AUTO] Initial sync error:", e));
          } else {
            console.log(`[AWS-AUTO] Account with access key ${accessKey} already exists.`);
          }
        } else {
          console.log(`[AWS-AUTO] Could not identify both access key and secret key.`);
        }
      }
    } catch (autoErr) {
      console.error("AWS Auto-detection error:", autoErr);
    }

    res.status(201).json(credential);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: err.errors[0].message,
        field: err.errors[0].path.join('.'),
      });
    }
    res.status(400).json({ message: "Invalid input" });
  }
});

app.delete("/api/credentials/:id", isAuth, async (req, res) => {
  await storage.deleteCredential(Number(req.params.id));
  res.status(204).send();
});

app.patch("/api/credentials/:id", isAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const input = insertCredentialSchema.partial().parse(req.body);
    const [updated] = await db.update(credentials).set(input).where(eq(credentials.id, id)).returning();
    if (!updated) return res.status(404).json({ message: "Credential not found" });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: "Invalid input" });
  }
});

app.get("/api/all-credentials", isAuth, async (req, res) => {
  const allCredentials = await db.select().from(credentials).orderBy(desc(credentials.createdAt));
  res.json(allCredentials);
});

app.get(api.orders.list.path, isAuth, async (req, res) => {
  const ordersList = await storage.getOrders();
  res.json(ordersList);
});

app.get(api.broadcast.channels.list.path, isAuth, async (req, res) => {
  const channels = await storage.getBroadcastChannels();
  res.json(channels);
});

const getBotToken = async () => {
  const setting = await storage.getSetting("TELEGRAM_BOT_TOKEN");
  return setting?.value || process.env.TELEGRAM_BOT_TOKEN;
};

const getBroadcastBot = async () => {
  const setting = await storage.getSetting("BROADCAST_BOT_TOKEN");
  const token = setting?.value || (await getBotToken());
  if (!token) return null;
  return new TelegramBot(token);
};

app.post(api.broadcast.send.path, isAuth, async (req, res) => {
  try {
    const { text, photo, buttonText, buttonUrl, channelIds, botType } = req.body;
    let targetChannels = [];

    let bBot: TelegramBot | null = null;
    if (botType === 'broadcast') {
      bBot = await getBroadcastBot();
    } else {
      bBot = bot; // Main bot
    }

    if (!bBot) {
      return res.status(400).json({ message: `${botType === 'broadcast' ? 'Broadcast' : 'Main'} bot is not initialized` });
    }

    if (channelIds && channelIds.length > 0) {
      targetChannels = channelIds;
    } else {
      // Fallback to all Telegram users if no specific channels selected
      const tgUsers = await storage.getAllTelegramUsers();
      targetChannels = tgUsers.map(u => u.telegramId);

      // If still no users, check broadcast channels
      if (targetChannels.length === 0) {
        const channels = await storage.getBroadcastChannels();
        targetChannels = channels.map(c => c.channelId);
      }
    }

    let countSent = 0;
    for (const channelId of targetChannels) {
      try {
        const opts: TelegramBot.SendMessageOptions = {
          parse_mode: 'Markdown'
        };
        if (buttonText && buttonUrl) {
          opts.reply_markup = {
            inline_keyboard: [[{ text: buttonText, url: buttonUrl }]]
          };
        }

        if (photo) {
          await bBot.sendPhoto(channelId, photo, {
            caption: text,
            ...opts
          } as any);
        } else {
          await bBot.sendMessage(channelId, text, opts);
        }
        countSent++;
      } catch (err) {
        console.error(`Failed to send message to channel ${channelId}:`, err);
      }
    }

    res.json({ success: true, count: countSent });
  } catch (err) {
    console.error('Broadcast error:', err);
    res.status(400).json({ message: "Invalid input" });
  }
});

let activeIntervals: Map<number, NodeJS.Timeout> = new Map();

const stopScheduledBroadcast = (id: number) => {
  const timer = activeIntervals.get(id);
  if (timer) {
    clearInterval(timer);
    activeIntervals.delete(id);
  }
};

const startScheduledBroadcast = (msg: any) => {
  const send = async () => {
    const messages = await storage.getBroadcastMessages();
    const current = messages.find(m => m.id === msg.id);
    if (!current || current.status !== 'active') {
      stopScheduledBroadcast(msg.id);
      return;
    }

    const channels = await storage.getBroadcastChannels();
    const bBot = await getBroadcastBot();
    if (bBot) {
      for (const channel of channels) {
        try {
          const opts: TelegramBot.SendMessageOptions = {};
          if (current.buttonText && current.buttonUrl) {
            opts.reply_markup = {
              inline_keyboard: [[{ text: current.buttonText, url: current.buttonUrl }]]
            };
          }

          if (current.imageUrl) {
            await bBot.sendPhoto(channel.channelId, current.imageUrl, {
              caption: current.content,
              ...opts
            });
          } else {
            await bBot.sendMessage(channel.channelId, current.content, opts);
          }
        } catch (err) { }
      }
      await storage.updateBroadcastMessage(msg.id, { sentCount: current.sentCount + 1 });
    }
  };

  const timer = setInterval(send, msg.interval * 60 * 1000);
  activeIntervals.set(msg.id, timer);
};

const initSchedules = async () => {
  try {
    const messages = await storage.getBroadcastMessages();
    for (const msg of messages) {
      if (msg.status === 'active' && msg.interval && msg.interval > 0) {
        startScheduledBroadcast(msg);
      }
    }
  } catch (err) {
    console.error('Failed to initialize broadcast schedules:', err);
  }
};
initSchedules();

app.post("/api/broadcast/schedule", isAuth, async (req, res) => {
  try {
    const { message, channelIds, interval } = req.body;

    if (!interval || interval <= 0) {
      return res.status(400).json({ message: "Invalid interval" });
    }

    const sendBroadcast = async () => {
      let targetChannels = [];
      if (channelIds && channelIds.length > 0) {
        targetChannels = channelIds;
      } else {
        const channels = await storage.getBroadcastChannels();
        targetChannels = channels.map(c => c.channelId);
      }

      const bBot = await getBroadcastBot();
      if (bBot) {
        for (const channelId of targetChannels) {
          try {
            await bBot.sendMessage(channelId, message);
          } catch (err) {
            console.error(`Scheduled broadcast failed for ${channelId}:`, err);
          }
        }
      }
    };

    sendBroadcast();
    setInterval(sendBroadcast, interval * 60 * 60 * 1000);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: "Invalid input" });
  }
});

app.post("/api/broadcast/upload", isAuth, upload.single('image'), (req: any, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ imageUrl });
});

app.get(api.stats.get.path, isAuth, async (req, res) => {
  try {
    const stats = await storage.getStats();
    res.json(stats);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get(api.telegramUsers.list.path, isAuth, async (req, res) => {
  try {
    const usersList = await storage.getAllTelegramUsers();
    res.json(usersList);
  } catch (err) {
    console.error('Telegram users list error:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.patch(api.telegramUsers.update.path, isAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const input = api.telegramUsers.update.input.parse(req.body);
    const user = await storage.updateTelegramUser(id, input);
    res.json(user);
  } catch (err) {
    console.error('Telegram user update error:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get(api.payments.list.path, isAuth, async (req, res) => {
  try {
    const allPayments = await storage.getAllPaymentsWithUsers();
    res.json(allPayments);
  } catch (err) {
    console.error('Payments list error:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Special Offers API
app.get("/api/special-offers", isAuth, async (req, res) => {
  try {
    const offers = await storage.getSpecialOffers();
    res.json(offers);
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/special-offers", isAuth, async (req, res) => {
  try {
    const body = { ...req.body };
    if (typeof body.expiresAt === 'string') {
      body.expiresAt = new Date(body.expiresAt);
    }
    const input = insertSpecialOfferSchema.parse(body);

    console.log(`Checking inventory for product ${input.productId}, bundle quantity ${input.bundleQuantity}`);
    // Check inventory before creating special offer
    const stock = await storage.getCredentialsByProduct(input.productId);
    const availableStock = stock.filter(c => c.status === 'available');
    console.log(`Available stock: ${availableStock.length}`);

    if (availableStock.length < input.bundleQuantity) {
      console.log(`Validation failed: Insufficient inventory`);
      return res.status(400).json({
        message: `Insufficient inventory for this bundle. Required: ${input.bundleQuantity}, Available: ${availableStock.length}`
      });
    }

    const offer = await storage.createSpecialOffer(input);
    res.status(201).json(offer);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: err.errors[0].message,
        field: err.errors[0].path.join('.'),
      });
    }
    console.error("Error creating special offer:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.patch("/api/special-offers/:id", isAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = { ...req.body };
    if (typeof body.expiresAt === 'string') {
      body.expiresAt = new Date(body.expiresAt);
    }
    const input = insertSpecialOfferSchema.partial().parse(body);

    // If we are updating quantity or product, check inventory
    if (input.productId !== undefined || input.bundleQuantity !== undefined) {
      const currentOffer = await storage.getSpecialOffer(id);
      if (currentOffer) {
        const productId = input.productId ?? currentOffer.productId;
        const bundleQuantity = input.bundleQuantity ?? currentOffer.bundleQuantity;

        const stock = await storage.getCredentialsByProduct(productId);
        const availableStock = stock.filter(c => c.status === 'available');

        if (availableStock.length < bundleQuantity) {
          return res.status(400).json({
            message: `Insufficient inventory for this bundle. Required: ${bundleQuantity}, Available: ${availableStock.length}`
          });
        }
      }
    }

    const offer = await storage.updateSpecialOffer(id, input);
    res.json(offer);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.errors[0].message });
    }
    console.error("Error updating special offer:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.delete("/api/special-offers/:id", isAuth, async (req, res) => {
  try {
    await storage.deleteSpecialOffer(Number(req.params.id));
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

const formatOfferMessage = (offer: any, productType: string) => {
  const priceUSD = (offer.price / 100).toFixed(2);
  const headerEmojiIds = [
    "6276128687649723695", "6275964744453068322", "6275873218699989657",
    "6275869662467069270", "6276120956708591159", "6276075885321786491",
    "6276045545672807753", "6273727139506295416", "6276107406086771779"
  ];
  const header = headerEmojiIds.map(id => `<tg-emoji emoji-id="${id}">🎁</tg-emoji>`).join('');
  const numEmojiMap: Record<string, string> = {
    "0": "6228712321716325542", "1": "6231028576104221771", "2": "6228508985079632140",
    "3": "6228892912206220866", "4": "6228651427670002796", "5": "6230754058974531742",
    "6": "6231061110481488717", "7": "6228541351953173776", "8": "6228898272325406140",
    "9": "6230968699965150268"
  };

  let text = `<tg-emoji emoji-id="5467538555158943525">💭</tg-emoji> <b>Special Offers (Bundle Deals)</b> <tg-emoji emoji-id="5456343263340405032">🛍</tg-emoji>\n━━━━━━━━━━━━━━━\n\n`;
  text += `${header}\n\n`;
  text += `<b>${offer.name}</b>\n\n`;
  text += `<tg-emoji emoji-id="6276134137963222688">🎁</tg-emoji> Quantity: <b>${offer.bundleQuantity} pcs</b>\n`;
  text += `<tg-emoji emoji-id="5201692367437974073">💸</tg-emoji> Bundle Price: <b>$${priceUSD}</b>\n\n`;

  if (offer.expiresAt) {
    const diff = new Date(offer.expiresAt).getTime() - Date.now();
    if (diff > 0) {
      const totalSeconds = Math.floor(diff / 1000);
      const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
      const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
      const s = (totalSeconds % 60).toString().padStart(2, '0');

      text += `<tg-emoji emoji-id="5206715082582533386">🤩</tg-emoji> <b>Hurry! Expires In</b> <tg-emoji emoji-id="5206715082582533386">🤩</tg-emoji>\n`;
      const formatTimeDigit = (digit: string | undefined) => {
        const d = digit || '0';
        return `<tg-emoji emoji-id="${numEmojiMap[d] || numEmojiMap['0']}">🎁</tg-emoji>`;
      };
      text += `${formatTimeDigit(h[0])}${formatTimeDigit(h[1])} <b>:</b> ${formatTimeDigit(m[0])}${formatTimeDigit(m[1])} <b>:</b> ${formatTimeDigit(s[0])}${formatTimeDigit(s[1])}\n`;
    }
  }
  text += `━━━━━━━━━━━━━━━\n`;
  return text;
};

const activeSessionTimers = new Map<string, NodeJS.Timeout>();
const confirmingOffers = new Set<string>();

// Global Background Broadcast Timer (runs every 30 seconds)
setInterval(async () => {
  try {
    const activeOffers = await storage.getActiveSpecialOffers();
    if (activeOffers.length === 0) return;

    const usersToUpdate = await storage.getTelegramUsersWithBroadcast();
    for (const u of usersToUpdate) {
      // Skip if user has an active fast session timer OR is currently confirming an offer
      const tgUser = await storage.getTelegramUser(u.telegramId);
      if (activeSessionTimers.has(u.telegramId) || confirmingOffers.has(u.telegramId) || (tgUser?.lastAction && tgUser.lastAction.startsWith('confirming_offer_'))) continue;

      try {
        const offer = activeOffers[0]; // For now, update with the latest active offer
        const product = offer.product;
        const productType = product?.type || "General";
        const text = formatOfferMessage(offer, productType);
        const priceUSD = (offer.price / 100).toFixed(2);

        await bot?.editMessageText(text, {
          chat_id: u.telegramId,
          message_id: u.lastOfferBroadcastId!,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: `🎁 Claim Your Offer ($${priceUSD})`, callback_data: `buy_offer_${offer.id}` }]]
          }
        });
      } catch (err: any) {
        if (err.message && err.message.includes("message is not modified")) continue;
        if (err.message && (err.message.includes("message to edit not found") || err.message.includes("chat not found"))) {
          await storage.updateTelegramUser(u.id, { lastOfferBroadcastId: null });
        }
      }
    }
  } catch (err) {
    console.error("Global broadcast timer error:", err);
  }
}, 30000);

const startFastTimer = async (telegramId: string, offerId: number, messageId: number) => {
  if (activeSessionTimers.has(telegramId)) {
    clearInterval(activeSessionTimers.get(telegramId)!);
  }

  const interval = setInterval(async () => {
    try {
      if (confirmingOffers.has(telegramId)) return;
      const tgUser = await storage.getTelegramUser(telegramId);
      if (tgUser?.lastAction && tgUser.lastAction.startsWith('confirming_offer_')) return;

      const offer = await storage.getSpecialOffer(offerId);
      if (!offer || (offer.expiresAt && new Date(offer.expiresAt).getTime() <= Date.now())) {
        clearInterval(interval);
        activeSessionTimers.delete(telegramId);
        return;
      }

      const product = await storage.getProduct(offer.productId);
      const text = formatOfferMessage(offer, product?.type || "General");
      const priceUSD = (offer.price / 100).toFixed(2);

      await bot?.editMessageText(text, {
        chat_id: telegramId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: `🎁 Claim Your Offer ($${priceUSD})`, callback_data: `buy_offer_${offer.id}` }]]
        }
      });
    } catch (err: any) {
      if (err.message && err.message.includes("message is not modified")) return;
      clearInterval(interval);
      activeSessionTimers.delete(telegramId);
    }
  }, 1000);

  activeSessionTimers.set(telegramId, interval);

  // Stop fast timer after 5 minutes of inactivity (default safety)
  setTimeout(() => {
    if (activeSessionTimers.get(telegramId) === interval) {
      clearInterval(interval);
      activeSessionTimers.delete(telegramId);
    }
  }, 300000);
};

app.post("/api/special-offers/:id/broadcast", isAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const offer = await storage.getSpecialOffer(id);
    if (!offer) return res.status(404).json({ message: "Special offer not found" });

    const product = await storage.getProduct(offer.productId);
    const productType = product?.type || "General";
    const priceUSD = (offer.price / 100).toFixed(2);

    const mainBot = bot;
    if (!mainBot) return res.status(400).json({ message: "Bot not initialized" });

    // Production: Scale broadcast to all active Telegram users
    const users = await storage.getAllTelegramUsers();
    const targets = users.map(u => u.telegramId);

    // Define the missing 'text' variable using the proper formatter
    const text = formatOfferMessage(offer, productType);

    let countSent = 0;
    for (const targetId of targets) {
      try {
        const sentMsg = await mainBot.sendMessage(targetId, text, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: `🎁 Claim Your Offer ($${priceUSD})`, callback_data: `buy_offer_${offer.id}` }]]
          }
        });

        if (sentMsg) {
          await storage.updateTelegramUserByChatId(targetId, { lastOfferBroadcastId: sentMsg.message_id });
        }

        countSent++;
      } catch (err) {
        console.error(`Failed to send premium broadcast to ${targetId}:`, err);
      }
    }

    res.json({ success: true, count: countSent });
  } catch (err) {
    console.error('Premium broadcast error:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// AWS Checker API
app.get("/api/aws/accounts", isAuth, async (req, res) => {
  try {
    // Periodic cleanup of expired payments
    await storage.expireOldPayments();

    const accounts = await storage.getAwsAccounts();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/aws/accounts", isAuth, async (req, res) => {
  try {
    const input = insertAwsAccountSchema.parse(req.body);
    const account = await storage.createAwsAccount(input);

    // Automatic 7-day sync after creation to show history immediately
    (async () => {
      try {
        console.log(`Initial 7-day sync for new account: ${account.name} (ID: ${account.id})`);
        await fetchActivity(account, 30);
      } catch (syncErr) {
        console.error(`Initial sync failed for account ${account.id}:`, syncErr);
      }
    })();

    res.status(201).json(account);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.errors[0].message });
    }
    res.status(500).json({ message: "Internal server error" });
  }
});

app.put("/api/aws/accounts/:id", isAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const account = await storage.updateAwsAccount(id, req.body);
    res.json(account);
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.delete("/api/aws/accounts/:id", isAuth, async (req, res) => {
  try {
    await storage.deleteAwsAccount(Number(req.params.id));
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/api/aws/activities", isAuth, async (req, res) => {
  try {
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const activities = await storage.getAwsActivities(accountId);
    res.json(activities);
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/aws/refresh", isAuth, async (req, res) => {
  try {
    const { accountIds, lookbackDays = 7 } = req.body || {};
    const allAccounts = await storage.getAwsAccounts();
    const accounts = (accountIds && Array.isArray(accountIds) && accountIds.length > 0)
      ? allAccounts.filter(a => accountIds.includes(a.id))
      : allAccounts;
    const results = [];
    for (const account of accounts) {
      const result = await fetchActivity(account, lookbackDays);
      results.push({ id: account.id, ...result });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.use('/uploads', express.static(path.join(process.cwd(), 'public/uploads')));
app.use('/tutorials', express.static(path.join(process.cwd(), 'public', 'tutorials')));

app.post("/api/broadcast/custom", isAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ message: "Message content is required" });
    }

    const telegramUsersList = await storage.getAllTelegramUsers();
    const bBot = await getBroadcastBot();

    if (!bBot) {
      return res.status(400).json({ message: "Bot not initialized" });
    }

    let countSent = 0;
    for (const user of telegramUsersList) {
      try {
        await bBot.sendMessage(user.telegramId, message, { parse_mode: 'Markdown' });
        countSent++;
      } catch (err) {
        console.error(`Failed to send custom broadcast to user ${user.telegramId}:`, err);
      }
    }

    res.json({ success: true, count: countSent });
  } catch (err) {
    console.error('Custom broadcast error:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/broadcast/availability", isAuth, async (req, res) => {
  try {
    const products = await storage.getProducts();
    const availableProducts = products.filter(p => p.status === 'available');

    const groupedProducts: Record<string, any[]> = {};
    for (const p of availableProducts) {
      const stockCount = (await storage.getCredentialsByProduct(p.id)).filter(c => c.status === 'available').length;
      if (stockCount > 0) {
        if (!groupedProducts[p.type]) groupedProducts[p.type] = [];
        groupedProducts[p.type].push({ ...p, stockCount });
      }
    }

    if (Object.keys(groupedProducts).length === 0) {
      return res.status(400).json({ message: "No accounts in stock to broadcast." });
    }

    let availabilityMsg = `<tg-emoji emoji-id="5215209935188534658">📋</tg-emoji> <b>Product Availability</b>\n\n`;
    for (const [category, items] of Object.entries(groupedProducts)) {
      let catIcon = '';
      const catLower = category.toLowerCase();
      if (catLower.includes('aws')) catIcon = '<tg-emoji emoji-id="5785025630055700143">☁️</tg-emoji> ';
      else if (catLower.includes('digital ocean') || catLower.includes('digitalocean')) catIcon = '<tg-emoji emoji-id="6235413342576450502">💧</tg-emoji> ';
      else if (catLower.includes('azure')) catIcon = '<tg-emoji emoji-id="6235420094265037090">☁️</tg-emoji> ';
      else if (catLower.includes('kamatera')) catIcon = '<tg-emoji emoji-id="6235239937566838722">☁️</tg-emoji> ';

      availabilityMsg += `➖➖➖ ${catIcon}<b>${category}</b> <tg-emoji emoji-id="5456343263340405032">🛍</tg-emoji> ➖➖➖\n`;
      for (const item of items) {
        let formattedName = item.name.replace(/🇱🇰/g, '<tg-emoji emoji-id="5224277294050192388">🇱🇰</tg-emoji>');
        if (!formattedName.includes('5785025630055700143')) {
          formattedName = formattedName.replace(/\bAWS\b/gi, '<tg-emoji emoji-id="5785025630055700143">☁️</tg-emoji> AWS');
        }
        availabilityMsg += `${formattedName} | $${(item.price / 100).toFixed(2)} | In stock ${item.stockCount} pcs\n`;
      }
      availabilityMsg += "\n";
    }

    // Use the main bot instead of the broadcast bot
    const mainBot = bot;

    if (!mainBot) {
      return res.status(400).json({ message: "Main bot not initialized" });
    }

    // Production: Scale broadcast to all active Telegram users
    const users = await storage.getAllTelegramUsers();
    const targets = users.map(u => u.telegramId);

    let countSent = 0;
    for (const targetId of targets) {
      try {
        await mainBot.sendMessage(targetId, availabilityMsg, { parse_mode: 'HTML' });
        countSent++;
      } catch (err) {
        console.error(`Failed to send availability to user ${targetId}:`, err);
      }
    }

    res.json({ success: true, count: countSent });
  } catch (err) {
    console.error('Broadcast availability error:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/settings", isAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    const updated = await storage.updateSetting(key, value);

    // Re-initialize bot if token changed
    if (key === "TELEGRAM_BOT_TOKEN" || key === "BROADCAST_BOT_TOKEN") {
      await initBot();
    }

    res.json(updated);
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/api/settings/:key", isAuth, async (req, res) => {
  try {
    const setting = await storage.getSetting(req.params.key);
    res.json(setting || { key: req.params.key, value: "" });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

// Backup Routes
app.get("/api/backups/config", isAuth, async (req, res) => {
  const configs = await storage.getBackupConfigs();
  res.json(configs[0] || null);
});

app.post("/api/backups/config", isAuth, async (req, res) => {
  try {
    const configs = await storage.getBackupConfigs();
    let result;
    if (configs.length > 0) {
      result = await storage.updateBackupConfig(configs[0].id, req.body);
    } else {
      result = await storage.createBackupConfig(req.body);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/api/backups/logs", isAuth, async (req, res) => {
  const logs = await storage.getBackupLogs(50);
  res.json(logs);
});

app.post("/api/backups/trigger", isAuth, async (req, res) => {
  const configs = await storage.getBackupConfigs();
  if (configs.length === 0) return res.status(400).json({ message: "No backup configuration found" });

  // Trigger in background
  BackupService.performBackup(configs[0].id).catch(err => console.error("Manual backup trigger failed:", err));
  res.json({ message: "Backup triggered successfully" });
});

let bot: TelegramBot | null = null;
let broadcastBot: TelegramBot | null = null;

const initBot = async () => {
  try {
    const token = await getBotToken();
    const broadcastTokenSetting = await storage.getSetting("BROADCAST_BOT_TOKEN");
    const broadcastToken = broadcastTokenSetting?.value;

    console.log('Initializing Telegram bots...');

    if (token) {
      if (bot) {
        console.log('Stopping existing main bot...');
        await bot.stopPolling();
      }
      bot = new TelegramBot(token, { polling: true });
      setupBotHandlers(bot);
      setupBotProfile(bot).catch(err => console.error('Failed to setup bot profile:', err));
      console.log('Main bot initialized successfully');
    }

    if (broadcastToken && broadcastToken !== token) {
      if (broadcastBot) {
        console.log('Stopping existing broadcast bot...');
        await broadcastBot.stopPolling();
      }
      broadcastBot = new TelegramBot(broadcastToken, { polling: true });
      setupBotHandlers(broadcastBot);
      console.log('Broadcast bot initialized successfully');
    } else if (broadcastBot) {
      await broadcastBot.stopPolling();
      broadcastBot = null;
    }
  } catch (err) {
    console.error('Telegram bot init failed:', err);
  }
};

const setupBotProfile = async (targetBot: TelegramBot) => {
  try {
    const miniAppUrlSetting = await storage.getSetting("MINI_APP_URL");
    const botAboutSetting = await storage.getSetting("BOT_ABOUT_TEXT");
    const botDescSetting = await storage.getSetting("BOT_DESCRIPTION_TEXT");

    const miniAppUrl = miniAppUrlSetting?.value;

    // Removed: Set Menu Button to point to Mini App per user request
    /*
    if (miniAppUrl) {
      await targetBot.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Open App',
          web_app: { url: miniAppUrl }
        }
      });
      console.log('Bot Menu Button set to:', miniAppUrl);
    }
    */

    // 2. Set Bot Descriptions
    if (botAboutSetting?.value) {
      await targetBot.setMyShortDescription({ short_description: botAboutSetting.value });
    }
    if (botDescSetting?.value) {
      await targetBot.setMyDescription({ description: botDescSetting.value });
    }

  } catch (err: any) {
    // Ignore errors related to bot profile setup if API key is restricted
    console.error('Bot profile setup warning:', err.message);
  }
};

const setupBotHandlers = (targetBot: TelegramBot) => {
  // Polling error handling
  targetBot.on('polling_error', (error: any) => {
    if (!(error.code === 'ETELEGRAM' && error.message.includes('409 Conflict'))) {
      console.error('Bot polling error:', error);
    }
  });

  targetBot.on('my_chat_member', async (update) => {
    const chat = update.chat;
    if (update.new_chat_member.status === 'member' || update.new_chat_member.status === 'administrator') {
      try {
        const channels = await storage.getBroadcastChannels();
        if (!channels.some(c => c.channelId === chat.id.toString())) {
          await storage.createBroadcastChannel({
            channelId: chat.id.toString(),
            name: chat.title || 'Auto-detected Group'
          });
        }
      } catch (err) {
        console.error('Failed to auto-register group:', err);
      }
    }
  });

  // Detect groups when a message is sent to them
  targetBot.on('message', async (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel') {
      try {
        const channels = await storage.getBroadcastChannels();
        if (!channels.some(c => c.channelId === msg.chat.id.toString())) {
          await storage.createBroadcastChannel({
            channelId: msg.chat.id.toString(),
            name: msg.chat.title || 'Auto-detected Group'
          });
        }
      } catch (err) {
        console.error('Failed to auto-register group from message:', err);
      }
    }
  });

  // Handle interactive features for both bots if they are groups/channels
  // But commands and user profiles are handled by the main bot (bot variable)
  
  targetBot.on('callback_query', async (query) => {
    // Only handle certain actions on the main bot
    const isMainBot = targetBot === bot;
    
    if (isMainBot) {
      try {
        const chatId = query.message?.chat.id;
        const userId = query.from.id.toString();
        if (!chatId) return;

      if (query.data === 'tutorial_menu') {
        const opts: TelegramBot.EditMessageTextOptions = {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: '⛱️ How to Buy Items', callback_data: 'tutorial_how_to_buy' }],
              [{ text: '🏖️ How to Deposit', callback_data: 'tutorial_how_to_deposit' }],
              [{ text: '🔙 Back to Profile', callback_data: 'profile_refresh' }]
            ]
          },
          parse_mode: 'Markdown'
        };
        try {
          await targetBot.editMessageText('📖 *Tutorial Menu*\n\nChoose a tutorial to watch:', opts);
        } catch (err) {
          console.error('Failed to edit message for tutorial menu:', err);
        }
        return;
      }

      if (query.data === 'tutorial_how_to_buy' || query.data === 'tutorial_how_to_deposit') {
        const settingKey = query.data === 'tutorial_how_to_buy' ? 'TUTORIAL_BUY_VIDEO' : 'TUTORIAL_DEPOSIT_VIDEO';
        const videoSetting = await storage.getSetting(settingKey);
        const videoValue = videoSetting?.value || (query.data === 'tutorial_how_to_buy' ? 'how_to_buy_itmes.mp4' : 'how_to_deposit.mp4');

        if (!videoValue) {
          await targetBot.answerCallbackQuery(query.id, { text: 'Tutorial video not available yet.', show_alert: true });
          return;
        }

        const title = query.data === 'tutorial_how_to_buy' ? 'How to Buy Items' : 'How to Deposit';

        // Answer callback to remove loading state
        await targetBot.answerCallbackQuery(query.id);

        // Send wait message
        const waitMsg = await targetBot.sendMessage(chatId, "⏳ *Preparing Tutorial...* please wait a moment.", { parse_mode: 'Markdown' });

        // Check if it's a file path or a URL
        if (videoValue.startsWith('http')) {
          await targetBot.sendMessage(chatId, `🏖️ *${title}*\n\nYou can watch the tutorial video here: ${videoValue}`, { parse_mode: 'Markdown' });
          if (waitMsg) await targetBot.deleteMessage(chatId, waitMsg.message_id).catch(() => { });
        } else {
          let fileName = videoValue;
          if (!fileName.toLowerCase().endsWith('.mp4')) {
            fileName += '.mp4';
          }

          // Ensure static route is available (re-added for reliability)
          app.use('/tutorials', express.static(path.join(process.cwd(), 'public', 'tutorials')));
          app.use('/tutorials_dist', express.static(path.join(process.cwd(), 'dist', 'public', 'tutorials')));

          const findVideoFile = (name: string) => {
            const root = process.cwd();
            const potential = [
              path.join(root, 'public', 'tutorials', name),
              path.join(root, 'dist', 'public', 'tutorials', name),
              path.join(root, 'client', 'public', 'tutorials', name),
              path.join(root, 'tutorials', name),
              path.resolve(root, '..', 'public', 'tutorials', name)
            ];
            
            for (const p of potential) {
              if (fs.existsSync(p)) return p;
            }
            return null;
          };

          const filePath = findVideoFile(fileName) || 
                           findVideoFile(videoValue) || 
                           findVideoFile(fileName.replace('itmes', 'items')) ||
                           findVideoFile(fileName.replace('items', 'itmes'));

          // Get the domain for fallback URL
          const miniAppUrlSetting = await storage.getSetting("MINI_APP_URL");
          const domain = miniAppUrlSetting?.value ? new URL(miniAppUrlSetting.value).origin : "";
          const fileUrl = domain ? `${domain}/tutorials/${fileName}` : "";

          console.log(`Attempting to send video: ${filePath} (Fallback URL: ${fileUrl})`);

          if (filePath && fs.existsSync(filePath)) {
            try {
              // Show uploading status in Telegram
              await targetBot.sendChatAction(chatId, 'upload_video');
              
              // Try sending using file path string (lib handles reading)
              await targetBot.sendVideo(chatId, filePath, {
                caption: `🏖️ *${title}*`,
                parse_mode: 'Markdown',
                supports_streaming: true
              });
              console.log('Video sent successfully using path string');
            } catch (sendErr: any) {
              console.error('sendVideo path error, trying document:', sendErr.message);
              try {
                await targetBot.sendChatAction(chatId, 'upload_document');
                // Try sending as document
                await targetBot.sendDocument(chatId, filePath, {
                  caption: `🏖️ *${title}* (Video File)`,
                  parse_mode: 'Markdown'
                }, { filename: fileName });
                console.log('Video sent successfully as document');
              } catch (docErr: any) {
                console.error('sendDocument error, trying URL:', docErr.message);
                if (fileUrl) {
                  try {
                    await targetBot.sendVideo(chatId, fileUrl, {
                      caption: `🏖️ *${title}*`,
                      parse_mode: 'Markdown'
                    });
                  } catch (urlErr: any) {
                    await targetBot.sendMessage(chatId, `❌ *Error*: Unable to play video directly.\n\n[Click here to watch](${fileUrl})`, { parse_mode: 'Markdown' });
                  }
                } else {
                  await targetBot.sendMessage(chatId, `❌ *Error*: Failed to send video. Please contact support.`, { parse_mode: 'Markdown' });
                }
              }
            } finally {
              if (waitMsg) await targetBot.deleteMessage(chatId, waitMsg.message_id).catch(() => { });
            }
            await targetBot.sendMessage(chatId, `📺 *${title}*\n\nVideo file missing on server. Please contact support.`, { parse_mode: 'Markdown' });
            if (waitMsg) await targetBot.deleteMessage(chatId, waitMsg.message_id).catch(() => { });
          }
        }
        return;
      }

      if (query.data === 'do_menu') {
        const tgUser = await storage.getTelegramUser(userId);
        if (!tgUser) return;

        let text = "🌊 *DigitalOcean Integration*\n\n";
        const keyboard = { inline_keyboard: [] as any[][] };

        if (!tgUser.doApiKey) {
          text += "You haven't set your DigitalOcean API key yet. Please provide it to enable droplet creation.";
          keyboard.inline_keyboard.push([{ text: '🔑 Set API Key', callback_data: 'do_set_key' }]);
        } else {
          text += "Your API key is saved. Select an option below:";
          keyboard.inline_keyboard.push([{ text: '🚀 Create Droplet', callback_data: 'do_region_select' }]);
          if (tgUser.lastDropletId) {
            keyboard.inline_keyboard.push([{ text: '📊 Monitoring & Info', callback_data: 'do_monitor_droplet' }]);
          }
          keyboard.inline_keyboard.push([{ text: '🔄 Update API Key', callback_data: 'do_set_key' }]);
        }
        keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'automation_menu' }]);

        await targetBot.editMessageText(text, {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        });
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data === 'automation_menu') {
        const automationEnabled = (await storage.getSetting('AUTOMATION_ENABLED'))?.value !== 'false';

        if (!automationEnabled) {
          await targetBot.answerCallbackQuery(query.id, {
            text: "⚠️ Automation features are currently disabled by admin.",
            show_alert: true
          });
          return;
        }

        const keyboard = {
          inline_keyboard: [
            [{ text: '🌊 DigitalOcean', callback_data: 'do_menu' }],
            [{ text: '🔙 Back', callback_data: 'profile_refresh' }]
          ]
        };
        await targetBot.editMessageText('🤖 *Automation & Cloud Providers*\n\nSelect a cloud provider to manage your resources:', {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        });
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data === 'do_monitor_droplet') {
        const tgUser = await storage.getTelegramUser(userId);
        if (!tgUser || !tgUser.doApiKey || !tgUser.lastDropletId) return;

        await targetBot.answerCallbackQuery(query.id, { text: "Fetching droplet info & stats..." });

        try {
          // Fetch Droplet Info
          const dropletRes = await axios.get(`https://api.digitalocean.com/v2/droplets/${tgUser.lastDropletId}`, {
            headers: { 'Authorization': `Bearer ${tgUser.doApiKey}` }
          });
          const droplet = dropletRes.data.droplet;

          // Fetch CPU Usage (last 5 minutes)
          const now = Math.floor(Date.now() / 1000);
          const start = now - 300;
          const cpuRes = await axios.get(`https://api.digitalocean.com/v2/monitoring/metrics/droplet/cpu`, {
            params: { host_id: tgUser.lastDropletId, start, end: now },
            headers: { 'Authorization': `Bearer ${tgUser.doApiKey}` }
          }).catch(() => null);

          // Fetch RAM Usage (last 5 minutes)
          const memRes = await axios.get(`https://api.digitalocean.com/v2/monitoring/metrics/droplet/memory_available`, {
            params: { host_id: tgUser.lastDropletId, start, end: now },
            headers: { 'Authorization': `Bearer ${tgUser.doApiKey}` }
          }).catch(() => null);

          const ipv4 = droplet.networks.v4.find((n: any) => n.type === 'public')?.ip_address || 'N/A';
          const ipv6 = droplet.networks.v6.find((n: any) => n.type === 'public')?.ip_address || 'N/A';

          let cpuUsage = 'N/A';
          if (cpuRes?.data?.data?.result) {
            const results = cpuRes.data.data.result;
            let totalUsage = 0;
            let count = 0;

            results.forEach((r: any) => {
              if (r.values && r.values.length > 0) {
                const latest = parseFloat(r.values[r.values.length - 1][1]);
                if (!isNaN(latest)) {
                  totalUsage += latest;
                  count++;
                }
              }
            });

            if (count > 0) {
              // DigitalOcean returns usage per core (0-1 range). 
              // For multi-core, total can be > 1.0 (e.g. 2 cores = 2.0 max)
              // But for monitoring we usually want the average percentage across cores or total usage.
              // The user screenshot showed 2337% which is 23.37 * 100.
              // We should multiply by 100 once.
              cpuUsage = `${(totalUsage * 100).toFixed(1)}%`;
            }
          }

          let memUsage = 'N/A';
          if (memRes?.data?.data?.result?.[0]?.values) {
            const values = memRes.data.data.result[0].values;
            const latestAvailable = parseFloat(values[values.length - 1][1]);
            memUsage = `${(latestAvailable / 1024 / 1024).toFixed(0)} MB Free`;
          }

          let text = `📊 *Droplet Monitoring*\n\n`;
          text += `🏷️ Name: \`${droplet.name}\`\n`;
          text += `🌐 IP IPv4: \`${ipv4}\`\n`;
          text += `🌐 IP IPv6: \`${ipv6}\`\n`;
          text += `📍 Region: \`${droplet.region.slug}\`\n`;
          text += `🔋 Status: \`${droplet.status}\`\n`;
          text += `⚡ Size: \`${droplet.size_slug}\`\n\n`;
          text += `📈 *Current Usage:*\n`;
          text += `🖥 CPU: \`${cpuUsage}\`\n`;
          text += `🧠 RAM: \`${memUsage}\`\n\n`;
          text += `💡 *How to enable monitoring?*\n`;
          text += `If it shows N/A, the DigitalOcean Agent is not installed or data hasn't arrived yet.\n\n`;
          text += `*Installation Command (Ubuntu/Debian):*\n`;
          text += `\`curl -sSL https://repos.insights.digitalocean.com/install.sh | sudo bash\`\n\n`;
          text += `Run this command inside your server to see real-time stats.`;

          const keyboard = {
            inline_keyboard: [
              [{ text: '🔄 Refresh', callback_data: 'do_monitor_droplet' }],
              [{ text: '🔙 Back', callback_data: 'do_menu' }]
            ]
          };

          await targetBot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            reply_markup: keyboard,
            parse_mode: 'Markdown'
          }).catch((err: any) => {
            if (!err.message.includes('message is not modified')) {
              throw err;
            }
          });
        } catch (err: any) {
          await targetBot.sendMessage(chatId, `❌ Failed to fetch info: ${err.response?.data?.message || err.message}`);
        }
        return;
      }

      if (query.data === 'do_region_select') {
        const keyboard = {
          inline_keyboard: [
            [{ text: '📀 Standard OS (Ubuntu, Debian...)', callback_data: 'do_type_os' }],
            [{ text: '🛒 Marketplace (WordPress, Docker...)', callback_data: 'do_type_marketplace' }],
            [{ text: '🔙 Back', callback_data: 'do_menu' }]
          ]
        };
        await targetBot.editMessageText('🚀 *Step 1: Choice Droplet Type*\n\nSelect the base image type for your droplet:', {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        });
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data?.startsWith('do_type_')) {
        const type = query.data.split('_')[2];
        await storage.updateTelegramUserByChatId(userId, { lastAction: `do_flow_type_${type}` });

        const regions = [
          { name: 'New York 3', slug: 'nyc3' },
          { name: 'Singapore 1', slug: 'sgp1' },
          { name: 'London 1', slug: 'lon1' },
          { name: 'Frankfurt 1', slug: 'fra1' }
        ];
        const keyboard = {
          inline_keyboard: [
            [{ text: 'New York 3', callback_data: 'do_reg_nyc3' }, { text: 'Singapore 1', callback_data: 'do_reg_sgp1' }],
            [{ text: 'London 1', callback_data: 'do_reg_lon1' }, { text: 'Frankfurt 1', callback_data: 'do_reg_fra1' }],
            [{ text: '🔙 Back', callback_data: 'do_region_select' }]
          ]
        };

        await targetBot.editMessageText('🌍 *Step 2: Choice Region*\n\nSelect a region for your droplet:', {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        });
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data?.startsWith('do_reg_')) {
        const region = query.data.split('_')[2];
        const tgUser = await storage.getTelegramUser(userId);
        const lastAction = tgUser?.lastAction || '';
        const type = lastAction.split('_')[3];

        await storage.updateTelegramUserByChatId(userId, { lastAction: `${lastAction}_reg_${region}` });

        if (type === 'marketplace') {
          const apps = [
            { name: 'CyberPanel on Ubuntu', slug: 'cyberpanel-22-04' },
            { name: 'LAMP on Ubuntu', slug: 'lamp-20-04' },
            { name: 'WordPress on Ubuntu', slug: 'wordpress-22-04' },
            { name: 'Docker on Ubuntu', slug: 'docker-20-04' },
            { name: 'cPanel & WHM', slug: 'cpanel-110-ubuntu' },
            { name: 'OpenVPN Access Server', slug: 'openvpn-as' }
          ];
          const keyboard = {
            inline_keyboard: [
              ...apps.map(a => ([{ text: a.name, callback_data: `do_os_${a.slug}` }])),
              [{ text: '🔙 Back', callback_data: `do_type_marketplace` }]
            ]
          };
          await targetBot.editMessageText('🛒 *Step 3: Choice Marketplace App*\n\nSelect an application from Marketplace:', {
            chat_id: chatId,
            message_id: query.message?.message_id,
            reply_markup: keyboard,
            parse_mode: 'Markdown'
          });
        } else {
          const systems = [
            { name: 'Ubuntu', slug: 'ubuntu' },
            { name: 'Debian', slug: 'debian' },
            { name: 'CentOS', slug: 'centos' },
            { name: 'Fedora', slug: 'fedora' }
          ];
          const keyboard = {
            inline_keyboard: [
              ...systems.map(s => ([{ text: s.name, callback_data: `do_os_${s.slug}` }])),
              [{ text: '🔙 Back', callback_data: `do_type_os` }]
            ]
          };
          await targetBot.editMessageText('💿 *Step 3: Choice OS*\n\nSelect an operating system:', {
            chat_id: chatId,
            message_id: query.message?.message_id,
            reply_markup: keyboard,
            parse_mode: 'Markdown'
          });
        }
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data?.startsWith('do_os_')) {
        const os = query.data.split('_')[2];
        const tgUser = await storage.getTelegramUser(userId);
        const lastAction = tgUser?.lastAction || '';
        const region = lastAction.split('_')[5];
        const type = lastAction.split('_')[3];

        await storage.updateTelegramUserByChatId(userId, { lastAction: `${lastAction}_os_${os}` });

        if (type === 'marketplace') {
          // Marketplace apps don't usually need version selection in this flow
          // Skip to CPU type selection
          const keyboard = {
            inline_keyboard: [
              [{ text: 'Shared CPU (Basic)', callback_data: 'do_cpu_basic' }],
              [{ text: 'Dedicated CPU (General)', callback_data: 'do_cpu_g' }],
              [{ text: '🔙 Back', callback_data: `do_reg_${region}` }]
            ]
          };
          await targetBot.editMessageText(`🌍 Region: ${region}\n🛒 App: ${os}\n\n💻 *Step 4: Choose CPU Type*\n\nSelect CPU architecture:`, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            reply_markup: keyboard,
            parse_mode: 'Markdown'
          });
        } else {
          const versions: Record<string, any[]> = {
            'ubuntu': [{ text: '24.04 x64', callback_data: 'do_ver_ubuntu-24-04-x64' }, { text: '22.04 x64', callback_data: 'do_ver_ubuntu-22-04-x64' }],
            'debian': [{ text: '12 x64', callback_data: 'do_ver_debian-12-x64' }, { text: '11 x64', callback_data: 'do_ver_debian-11-x64' }],
            'centos': [{ text: 'Stream 9 x64', callback_data: 'do_ver_centos-stream-9-x64' }],
            'fedora': [{ text: '40 x64', callback_data: 'do_ver_fedora-40-x64' }]
          };

          const keyboard = {
            inline_keyboard: [
              ...(versions[os] || []).map(v => [v]),
              [{ text: '🔙 Back', callback_data: `do_reg_${region}` }]
            ]
          };
          await targetBot.editMessageText(`🌍 Region: ${region}\n📀 OS: ${os}\n\n🔢 *Step 4: Version*\n\nSelect a version:`, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            reply_markup: keyboard,
            parse_mode: 'Markdown'
          });
        }
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data?.startsWith('do_ver_')) {
        const version = query.data.split('_')[2];
        const tgUser = await storage.getTelegramUser(userId);
        const lastAction = tgUser?.lastAction || '';
        const region = lastAction.split('_')[5];
        const os = lastAction.split('_')[7];
        await storage.updateTelegramUserByChatId(userId, { lastAction: `${lastAction}_ver_${version}` });

        const keyboard = {
          inline_keyboard: [
            [{ text: 'Shared CPU (Basic)', callback_data: 'do_cpu_basic' }],
            [{ text: 'Dedicated CPU (General)', callback_data: 'do_cpu_g' }],
            [{ text: '🔙 Back', callback_data: `do_os_${os}` }]
          ]
        };
        await targetBot.editMessageText(`🌍 Region: ${region}\n📀 OS: ${os} (${version})\n\n💻 *Step 5: Choose CPU Type*\n\nSelect CPU architecture:`, {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        });
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data?.startsWith('do_cpu_')) {
        const cpuType = query.data.split('_')[2];
        const tgUser = await storage.getTelegramUser(userId);
        const lastAction = tgUser?.lastAction || '';
        const version = lastAction.split('_')[7];
        await storage.updateTelegramUserByChatId(userId, { lastAction: `${lastAction}_cpu_${cpuType}` });

        const basicSizes = [
          { text: '1 vCPU / 1GB RAM ($6/mo)', callback_data: 'do_size_s-1vcpu-1gb' },
          { text: '1 vCPU / 2GB RAM ($12/mo)', callback_data: 'do_size_s-1vcpu-2gb' },
          { text: '2 vCPU / 2GB RAM ($18/mo)', callback_data: 'do_size_s-2vcpu-2gb' }
        ];
        const dedicatedSizes = [
          { text: '2 vCPU / 8GB RAM ($63/mo)', callback_data: 'do_size_g-2vcpu-8gb' },
          { text: '4 vCPU / 16GB RAM ($126/mo)', callback_data: 'do_size_g-4vcpu-16gb' }
        ];

        const keyboard = {
          inline_keyboard: [
            ...(cpuType === 'basic' ? basicSizes : dedicatedSizes).map(s => [s]),
            [{ text: '🔙 Back', callback_data: `do_ver_${version}` }]
          ]
        };
        await targetBot.editMessageText(`🌍 Region: ${tgUser?.lastAction?.split('_')[3]}\n📀 OS: ${tgUser?.lastAction?.split('_')[5]}\n💻 CPU: ${cpuType}\n\n💰 *Step 6: Choice Size & Price*\n\nSelect droplet size:`, {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        });
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data?.startsWith('do_size_')) {
        const size = query.data.split('_')[2];
        const tgUser = await storage.getTelegramUser(userId);
        const lastAction = tgUser?.lastAction || '';
        await storage.updateTelegramUserByChatId(userId, { lastAction: `${lastAction}_sz_${size}` });

        const keyboard = {
          inline_keyboard: [
            [{ text: '🔑 SSH Key', callback_data: 'do_auth_ssh' }, { text: '🔡 Password', callback_data: 'do_auth_pass' }],
            [{ text: '🔙 Back', callback_data: `do_cpu_${lastAction.split('_')[9]}` }]
          ]
        };
        await targetBot.editMessageText(`🌍 Region: ${lastAction.split('_')[3]}\n📀 OS: ${lastAction.split('_')[5]}\n💻 Size: ${size}\n\n🔐 *Step 7: Auth Method*\n\nHow do you want to access your droplet?`, {
          chat_id: chatId,
          message_id: query.message?.message_id,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        });
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data === 'do_auth_pass') {
        await storage.updateTelegramUserByChatId(userId, { lastAction: (await storage.getTelegramUser(userId))?.lastAction + '_auth_pass_await' });
        await targetBot.sendMessage(chatId, "Please enter a secure password for your new droplet:");
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data === 'do_auth_ssh') {
        await storage.updateTelegramUserByChatId(userId, { lastAction: (await storage.getTelegramUser(userId))?.lastAction + '_auth_ssh_await' });
        await targetBot.sendMessage(chatId, "Please send your public SSH key (starting with ssh-rsa, etc.):");
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data === 'do_set_key') {
        await storage.updateTelegramUserByChatId(userId, { lastAction: 'awaiting_do_api_key' });
        await targetBot.sendMessage(chatId, "Please send your DigitalOcean Personal Access Token (API Key):");
        await targetBot.answerCallbackQuery(query.id);
        return;
      }

      if (query.data === 'do_create_droplet') {
        const tgUser = await storage.getTelegramUser(userId);
        if (!tgUser || !tgUser.doApiKey) return;

        const lastAction = tgUser.lastAction || '';
        const size = lastAction.includes('_sz_') ? lastAction.split('_sz_')[1].split('_')[0] : 's-1vcpu-1gb';
        const region = lastAction.includes('_reg_') ? lastAction.split('_reg_')[1].split('_')[0] : 'nyc3';
        const os = lastAction.includes('_os_') ? lastAction.split('_os_')[1].split('_')[0] : 'ubuntu';
        const version = lastAction.includes('_ver_') ? lastAction.split('_ver_')[1].split('_')[0] : '24-04-x64';

        // Clean up size string - ensure it doesn't have extra underscores or trailing text
        const cleanSize = size.replace(/[^a-zA-Z0-9-]/g, '');
        const cleanRegion = region.replace(/[^a-zA-Z0-9-]/g, '');

        const image = os.includes('-') ? os : `${os}-${version}`;

        await targetBot.answerCallbackQuery(query.id, { text: "Creating droplet... Please wait." });

        try {
          const response = await axios.post('https://api.digitalocean.com/v2/droplets', {
            name: `cloudshop-${userId}-${Math.floor(Date.now() / 1000)}`,
            region: cleanRegion,
            size: cleanSize,
            image: image
          }, {
            headers: {
              'Authorization': `Bearer ${tgUser.doApiKey}`,
              'Content-Type': 'application/json'
            }
          });

          const droplet = response.data.droplet;
          await storage.updateTelegramUserByChatId(userId, { lastDropletId: droplet.id.toString() });

          await targetBot.sendMessage(chatId, `✅ Droplet created successfully!\n\nName: ${droplet.name}\nStatus: ${droplet.status}\n\nIt will be ready in a few minutes.`);
        } catch (err: any) {
          console.error('DO Create error:', err.response?.data || err.message);
          await targetBot.sendMessage(chatId, `❌ Failed to create droplet: ${err.response?.data?.message || err.message}`);
        }
        return;
      }

      if (query.data === 'profile_refresh') {
        const tgUser = await storage.getTelegramUser(userId);
        if (!tgUser) return;
        const allOrders = await storage.getOrders();
        const userPurchases = allOrders.filter(o => o.telegramUserId === tgUser.id).length;
        const balanceUSD = (tgUser.balance / 100).toFixed(2);
        const regDate = tgUser.createdAt ? format(tgUser.createdAt, "yyyy-MM-dd HH:mm:ss") : "N/A";

        const automationSetting = await storage.getSetting("AUTOMATION_ENABLED");
        const isAutomationEnabled = automationSetting?.value === "true";

        const specialOffersSetting = await storage.getSetting("SPECIAL_OFFERS_ENABLED");
        const isSpecialOffersEnabled = specialOffersSetting?.value !== "false";

        let hasActiveOffers = false;
        try {
          const activeOffers = await storage.getActiveSpecialOffers();
          hasActiveOffers = activeOffers.length > 0;
        } catch (err) {
          console.error("Error fetching active offers for profile:", err);
        }

        const inline_keyboard = [
          [{ text: '💰 Add funds', callback_data: 'add_funds' }, { text: '📜 Purchase history', callback_data: 'purchase_history' }],
          isAutomationEnabled
            ? [{ text: '🤖 Automation', callback_data: 'automation_menu' }, { text: '📖 Tutorial', callback_data: 'tutorial_menu' }]
            : [{ text: '📖 Tutorial', callback_data: 'tutorial_menu' }]
        ];

        if (isSpecialOffersEnabled && hasActiveOffers) {
          inline_keyboard.push([{ text: '🎁 Special Offers', callback_data: 'special_offers' }]);
        }

        const keyboard = { inline_keyboard };

        if (query.message?.message_id) {
          await targetBot.editMessageText(`<tg-emoji emoji-id="5467538555158943525">💭</tg-emoji> <b>Your Profile</b> <tg-emoji emoji-id="5456343263340405032">🛍</tg-emoji>\n━━━━━━━━━━━━━━━\n<tg-emoji emoji-id="6276090299232031662">✅</tg-emoji> <b>ID:</b> ${tgUser.telegramId}\n\n<tg-emoji emoji-id="5201692367437974073">💵</tg-emoji> <b>Balance:</b> ${balanceUSD}$\n\n<tg-emoji emoji-id="5348256365477382384">⭐️</tg-emoji> <b>Purchased pcs:</b> ${userPurchases} pcs\n\n<tg-emoji emoji-id="5805188079148863343">🕒</tg-emoji> <b>Registration:</b> ${regDate}`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: keyboard,
            parse_mode: 'HTML'
          });
        }
        return;
      }
    } catch (err) {
      console.error("Global Callback Listener 1 Error:", err);
    }
    }
  });

  targetBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const parameter = match ? match[1] : null;

      // Fetch branding settings
      const storeNameSetting = await storage.getSetting("STORE_NAME");
      const storeName = storeNameSetting?.value || "Imesh cloud store";

      const supportBtnTextSetting = await storage.getSetting("SUPPORT_BTN_TEXT");
      const supportBtnText = supportBtnTextSetting?.value || "Write to support";

      const baseUrl = process.env.BASE_URL || (process.env.REPL_SLUG ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` : 'https://your-domain.com');
      const shopUrl = `${baseUrl}/shop`;

      const opts: TelegramBot.SendMessageOptions = {
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: [
            [{ text: '🛍️ Buy' }, { text: '👤 Profile' }, { text: '📋 Availability' }],
            [{ text: `💬 ${supportBtnText}` }, { text: '❓ FAQ' }]
          ],
          resize_keyboard: true
        }
      };

      // If no parameter, show the standard welcome message
      if (!parameter) {
        targetBot.sendMessage(chatId, `<b>Welcome to ${storeName} !</b> <tg-emoji emoji-id="5456343263340405032">🛍</tg-emoji>\n\n<b>Select an option below:</b> <tg-emoji emoji-id="5231102735817918643">🔖</tg-emoji>`, opts);
      } else if (parameter.startsWith('offer_')) {
        const offerId = parseInt(parameter.substring(6));
        const offer = await storage.getSpecialOffer(offerId);
        if (offer) {
          const product = await storage.getProduct(offer.productId);
          const tgUser = await storage.getTelegramUser(msg.from?.id.toString() || "");
          if (tgUser && product) {
            // 1. Balance Check - If insufficient, show unsuccessful message
            if (tgUser.balance < offer.price) {
              const errorMsg = `❌ <b>Purchase Unsuccessful</b>\n\n` +
                `━━━━━━━━━━━━━━━\n` +
                `🎁 Offer: <b>${offer.name}</b>\n` +
                `💵 Price: <b>$${(offer.price / 100).toFixed(2)}</b>\n` +
                `💰 Your Balance: <b>$${(tgUser.balance / 100).toFixed(2)}</b>\n\n` +
                `Please top-up your balance and try again.`;

              return targetBot.sendMessage(chatId, errorMsg, {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[{ text: '💰 Add Funds', callback_data: 'add_funds' }]]
                }
              });
            }

            // 2. Sufficient Balance - Show Confirm Button instead of asking quantity
            const stock = await storage.getCredentialsByProduct(product.id);
            const availableStock = stock.filter(c => c.status === 'available').length;

            if (availableStock < (offer.bundleQuantity || 1)) {
              const claimedMsg = `<tg-emoji emoji-id="5215209935188534658">⚠️</tg-emoji> <b>Claim Unsuccessful</b>\n\n` +
                `This offer has been already claimed by another person! <tg-emoji emoji-id="5231102735817918643">🤍</tg-emoji>`;
              return targetBot.sendMessage(chatId, claimedMsg, { parse_mode: 'HTML' });
            }

            const confirmMsg = `🎁 <b>Confirm Your Purchase</b>\n\n` +
              `You are about to claim: <b>${offer.name}</b>\n` +
              `Total Price: <b>$${(offer.price / 100).toFixed(2)}</b>\n\n` +
              `Would you like to proceed with the purchase?`;

            const keyboard = {
              inline_keyboard: [
                [{ text: '✅ Confirm Purchase', callback_data: `confirm_offer_${offerId}` }],
                [{ text: '❌ Cancel', callback_data: 'cancel_purchase' }]
              ]
            };

            return targetBot.sendMessage(chatId, confirmMsg, {
              parse_mode: 'HTML',
              reply_markup: keyboard
            });
          }
        }
        
        // Fetch store name for fallback welcome
        const storeNameSetting = await storage.getSetting("STORE_NAME");
        const storeName = storeNameSetting?.value || "Imesh cloud store";
        
        targetBot.sendMessage(chatId, `<b>Welcome to ${storeName} !</b> <tg-emoji emoji-id="5456343263340405032">🛍</tg-emoji>\n\n<b>Select an option below:</b> <tg-emoji emoji-id="5231102735817918643">🔖</tg-emoji>`, opts);
      }

      if (msg.from) {
        const tgUser = await storage.getTelegramUser(msg.from.id.toString());
        if (!tgUser) {
          await storage.createTelegramUser({
            telegramId: msg.from.id.toString(),
            username: msg.from.username,
            firstName: msg.from.first_name,
            lastName: msg.from.last_name,
            balance: 0,
            lastAction: null
          });
        } else {
          // Reset state on /start if user already exists
          await storage.updateTelegramUser(tgUser.id, { lastAction: null });
        }
      }
    });

    // Global message deduplication to prevent double messages
    const processedMessages = new Set<string>();
    const isDuplicateMessage = (msgId: number, chatId: number) => {
      const key = `${chatId}:${msgId}`;
      if (processedMessages.has(key)) return true;
      processedMessages.add(key);
      setTimeout(() => processedMessages.delete(key), 30000); // 30s cache
      return false;
    };

    targetBot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id.toString();
      if (!userId) return;
      const tgUser = await storage.getTelegramUser(userId);

      // Bypass processing if message is a command
      if (msg.text?.startsWith('/')) return;

      // Option 2: Start fast countdown on any message interaction
      let activeOffersMsg = [];
      try {
        activeOffersMsg = await storage.getActiveSpecialOffers();
      } catch (err) { }
      
      if (tgUser?.lastOfferBroadcastId && activeOffersMsg.length > 0) {
        startFastTimer(userId, activeOffersMsg[0].id, tgUser.lastOfferBroadcastId);
      }

      if (tgUser?.lastAction?.startsWith('awaiting_screenshot_') && msg.photo) {
        const parts = tgUser.lastAction.split('_');
        const method = parts[2];
        const amount = parts[3];
        const botInstance = targetBot;
        if (botInstance) {
          await botInstance.sendMessage(chatId, `✅ Screenshot received! Your $${amount} top-up via ${method} is being reviewed.`);
          await storage.updateTelegramUser(parseInt(userId), { lastAction: null });
          const adminSetting = await storage.getSetting('ADMIN_CHAT_ID');
          if (adminSetting?.value) {
            const photo = msg.photo[msg.photo.length - 1].file_id;
            await botInstance.sendPhoto(adminSetting.value, photo, {
              caption: `💰 *New Deposit Proof*\nUser: \`${userId}\`\nMethod: ${method}\nAmount: $${amount}`,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Approve', callback_data: `approve_dep_${userId}_${amount}` },
                  { text: '❌ Reject', callback_data: `reject_dep_${userId}` }
                ]]
              }
            });

            // Emit real-time notification to Admin Dashboard
            io.emit('admin_notification', {
              type: 'deposit',
              title: 'New Deposit Proof',
              message: `User ${userId} sent a proof for $${amount} via ${method}`,
              data: { userId, amount, method }
            });

            // Emit Native Push Notification
            sendAdminPushNotification(
              'New Deposit Proof',
              `User ${userId} sent a proof for $${amount} via ${method}`
            ).catch(console.error);
          }
        }
        return;
      }

      if (isDuplicateMessage(msg.message_id, msg.chat.id)) return;

      if (msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel') {
        try {
          const channels = await storage.getBroadcastChannels();
          if (!channels.some(c => c.channelId === msg.chat.id.toString())) {
            await storage.createBroadcastChannel({
              channelId: msg.chat.id.toString(),
              name: msg.chat.title || 'Auto-detected Group'
            });
          }
        } catch (err) { }
      }
    });

    targetBot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text;
      const userId = msg.from?.id.toString();
      if (!userId) return;

      const tgUser = await storage.getTelegramUser(userId);

      // Standardize text comparison by trimming and ignoring case if necessary
      const normalizedText = text?.trim();
      
      const supportBtnTextSetting = await storage.getSetting("SUPPORT_BTN_TEXT");
      const supportBtnText = supportBtnTextSetting?.value || "Write to support";

      if (normalizedText === '🛍️ Buy' || normalizedText === '📋 Availability' || normalizedText === 'Buy') {
        console.log(`Buy/Availability requested for user: ${userId}`);
        const products = await storage.getProducts();

        const availableProducts = [];
        for (const p of products) {
          if (p.status !== 'available') continue;
          const stock = (await storage.getCredentialsByProduct(p.id)).filter(c => c.status === 'available');
          if (stock.length > 0) {
            availableProducts.push({ ...p, stockCount: stock.length });
          }
        }

        if (availableProducts.length === 0) {
          const botInstance = targetBot;
          if (botInstance) await botInstance.sendMessage(chatId, 'Sorry, no accounts available right now.');
          return;
        }

        if (normalizedText === '📋 Availability') {
          const groupedProducts: Record<string, any[]> = {};
          for (const p of availableProducts) {
            if (!groupedProducts[p.type]) groupedProducts[p.type] = [];
            groupedProducts[p.type].push(p);
          }

          let response = "<tg-emoji emoji-id=\"5215209935188534658\">📋</tg-emoji> <b>Product Availability</b>\n\n";
          for (const [category, items] of Object.entries(groupedProducts)) {
            let catIcon = '';
            const catLower = category.toLowerCase();
            if (catLower.includes('aws')) catIcon = '<tg-emoji emoji-id="5785025630055700143">☁️</tg-emoji> ';
            else if (catLower.includes('digital ocean') || catLower.includes('digitalocean')) catIcon = '<tg-emoji emoji-id="6235413342576450502">💧</tg-emoji> ';
            else if (catLower.includes('azure')) catIcon = '<tg-emoji emoji-id="6235420094265037090">☁️</tg-emoji> ';
            else if (catLower.includes('kamatera')) catIcon = '<tg-emoji emoji-id="6235239937566838722">☁️</tg-emoji> ';

            response += `➖➖➖ ${catIcon}<b>${category}</b> <tg-emoji emoji-id="5456343263340405032">🛍</tg-emoji> ➖➖➖\n`;
            for (const item of items) {
              let formattedName = item.name.replace(/🇱🇰/g, '<tg-emoji emoji-id="5224277294050192388">🇱🇰</tg-emoji>');

              // Also add custom icons to AWS names if it starts with AWS but avoid double tagging 
              if (!formattedName.includes('5785025630055700143')) {
                formattedName = formattedName.replace(/\bAWS\b/gi, '<tg-emoji emoji-id="5785025630055700143">☁️</tg-emoji> AWS');
              }

              response += `${formattedName} | $${(item.price / 100).toFixed(2)} | In stock ${item.stockCount} pcs\n`;
            }
            response += "\n";
          }
          const botInstance = targetBot;
          if (botInstance) await botInstance.sendMessage(chatId, response, { parse_mode: 'HTML' });
          return;
        }

        const categories = Array.from(new Set(availableProducts.map(p => p.type as string)));
        const keyboard = categories.map(cat => {
          let btnText = cat;
          const catLower = cat.toLowerCase();
          if (catLower.includes('aws')) btnText = '☁️ AWS';
          else if (catLower.includes('digital ocean') || catLower.includes('digitalocean')) btnText = '💧 Digital Ocean';
          else if (catLower.includes('azure')) btnText = '☁️ Azure';
          else if (catLower.includes('kamatera')) btnText = '☁️ Kamatera';
          return [{ text: btnText, callback_data: `cat_${cat}` }];
        });
        const botInstance = targetBot;
        if (botInstance) {
          await botInstance.sendMessage(chatId, `<tg-emoji emoji-id="6276134137963222688">🛍</tg-emoji> <b>Select the product you need</b> <tg-emoji emoji-id="5231102735817918643">🎁</tg-emoji>`, {
            reply_markup: {
              inline_keyboard: keyboard
            },
            parse_mode: 'HTML'
          });
        }
      } else if (tgUser?.lastAction?.includes('_auth_pass_await')) {
        const password = normalizedText || '';
        const flowData = tgUser.lastAction.split('_');
        const region = flowData[3];
        const image = flowData[7];
        const size = flowData[11];

        if (password.length < 8) {
          await targetBot.sendMessage(chatId, "❌ Password must be at least 8 characters long. Please try again:");
          return;
        }

        await storage.updateTelegramUserByChatId(userId, { lastAction: null });
        await targetBot.sendMessage(chatId, "🚀 Starting droplet creation... Please wait.");

        try {
          const response = await axios.post('https://api.digitalocean.com/v2/droplets', {
            name: `cloudshop-${userId}-${Math.floor(Date.now() / 1000)}`,
            region: region,
            size: size,
            image: image,
            password: password
          }, {
            headers: {
              'Authorization': `Bearer ${tgUser.doApiKey}`,
              'Content-Type': 'application/json'
            }
          });
          const droplet = response.data.droplet;
          await storage.updateTelegramUserByChatId(userId, { lastDropletId: droplet.id.toString() });

          await targetBot.sendMessage(chatId, `✅ Droplet creation started!\n\nName: \`${droplet.name}\`\nRegion: \`${region}\`\nOS: \`${image}\`\nSize: \`${size}\`\n\nI will notify you once the IP address is assigned.`);

          // Poll for IP address
          let attempts = 0;
          const pollInterval = setInterval(async () => {
            attempts++;
            if (attempts > 20) {
              clearInterval(pollInterval);
              return;
            }
            try {
              const checkRes = await axios.get(`https://api.digitalocean.com/v2/droplets/${droplet.id}`, {
                headers: { 'Authorization': `Bearer ${tgUser.doApiKey}` }
              });
              const updatedDroplet = checkRes.data.droplet;
              const ipv4 = updatedDroplet.networks.v4.find((n: any) => n.type === 'public')?.ip_address;
              if (ipv4) {
                clearInterval(pollInterval);
                await targetBot.sendMessage(chatId, `🌐 *Droplet Access Info*\n\nIP IPv4: \`${ipv4}\`\nPassword: \`${password}\`\n\nYou can now connect via SSH.`);
              }
            } catch (e) { }
          }, 15000);

        } catch (err: any) {
          await targetBot.sendMessage(chatId, `❌ Creation failed: ${err.response?.data?.message || err.message}`);
        }
      } else if (tgUser?.lastAction?.includes('_auth_ssh_await')) {
        const sshKey = normalizedText;
        const flowData = tgUser.lastAction.split('_');
        const region = flowData[3];
        const image = flowData[7];
        const size = flowData[11];

        await storage.updateTelegramUserByChatId(userId, { lastAction: null });
        await targetBot.sendMessage(chatId, "🚀 Creating SSH key & droplet... Please wait.");

        try {
          // Register SSH Key first
          const sshResponse = await axios.post('https://api.digitalocean.com/v2/account/keys', {
            name: `key-${userId}-${Math.floor(Date.now() / 1000)}`,
            public_key: sshKey
          }, {
            headers: { 'Authorization': `Bearer ${tgUser.doApiKey}` }
          });

          const response = await axios.post('https://api.digitalocean.com/v2/droplets', {
            name: `cloudshop-${userId}-${Math.floor(Date.now() / 1000)}`,
            region: region,
            size: size,
            image: image,
            ssh_keys: [sshResponse.data.ssh_key.id]
          }, {
            headers: {
              'Authorization': `Bearer ${tgUser.doApiKey}`,
              'Content-Type': 'application/json'
            }
          });
          const droplet = response.data.droplet;
          await storage.updateTelegramUserByChatId(userId, { lastDropletId: droplet.id.toString() });

          await targetBot.sendMessage(chatId, `✅ Droplet created with SSH key!\n\nName: ${droplet.name}\nRegion: ${region}\nOS: ${image}\n\nAccess info will be ready shortly. I will poll for the IP address...`);

          // Poll for IP address
          let attempts = 0;
          const pollInterval = setInterval(async () => {
            attempts++;
            if (attempts > 10) {
              clearInterval(pollInterval);
              return;
            }
            try {
              const checkRes = await axios.get(`https://api.digitalocean.com/v2/droplets/${droplet.id}`, {
                headers: { 'Authorization': `Bearer ${tgUser.doApiKey}` }
              });
              const updatedDroplet = checkRes.data.droplet;
              const ipv4 = updatedDroplet.networks.v4.find((n: any) => n.type === 'public')?.ip_address;
              if (ipv4) {
                clearInterval(pollInterval);
                await targetBot.sendMessage(chatId, `🌐 *Droplet Access Info*\n\nIP IPv4: \`${ipv4}\`\nSSH Key: (Already added)\n\nYou can now connect via SSH.`);
              }
            } catch (e) { }
          }, 15000);

        } catch (err: any) {
          await targetBot.sendMessage(chatId, `❌ Creation failed: ${err.response?.data?.message || err.message}`);
        }
      } else if (tgUser?.lastAction === 'awaiting_do_api_key') {
        const apiKey = normalizedText?.trim();
        if (!apiKey) return;

        await storage.updateTelegramUserByChatId(userId, {
          doApiKey: apiKey,
          lastAction: null
        });
        await targetBot.sendMessage(chatId, "✅ DigitalOcean API key saved! You can now create droplets from your profile.");
      } else if (normalizedText === '👤 Profile') {
        console.log(`Profile requested for user: ${userId}`);
        const userToDisplay = tgUser || await storage.createTelegramUser({
          telegramId: userId,
          username: msg.from?.username || null,
          firstName: msg.from?.first_name || 'User',
          lastName: msg.from?.last_name || null,
          balance: 0,
          lastAction: null
        });

        const allOrders = await storage.getOrders();
        const userPurchases = allOrders.filter(o => o.telegramUserId === userToDisplay.id).length;
        const balanceUSD = (userToDisplay.balance / 100).toFixed(2);
        const regDate = userToDisplay.createdAt ? format(userToDisplay.createdAt, "yyyy-MM-dd HH:mm:ss") : "N/A";
        const automationSetting = await storage.getSetting("AUTOMATION_ENABLED");
        const isAutomationEnabled = automationSetting?.value === "true";

        const specialOffersSetting = await storage.getSetting("SPECIAL_OFFERS_ENABLED");
        const isSpecialOffersEnabled = specialOffersSetting?.value !== "false"; // Default to true

        const baseUrl = process.env.BASE_URL || (process.env.REPL_SLUG ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` : 'https://your-domain.com');
        const shopUrl = `${baseUrl}/shop`;

        const inline_keyboard = [
          [{ text: '💰 Add funds', callback_data: 'add_funds' }, { text: '📜 Purchase history', callback_data: 'purchase_history' }],
          isAutomationEnabled
            ? [{ text: '🤖 Automation', callback_data: 'automation_menu' }, { text: '📖 Tutorial', callback_data: 'tutorial_menu' }]
            : [{ text: '📖 Tutorial', callback_data: 'tutorial_menu' }]
        ];

        if (isSpecialOffersEnabled) {
          inline_keyboard.push([{ text: '🎁 Special Offers', callback_data: 'special_offers' }]);
        }

        const keyboard = { inline_keyboard };
        console.log('Sending keyboard:', JSON.stringify(keyboard));

        const botInstance = targetBot;
        if (botInstance) {
          await botInstance.sendMessage(chatId, `<tg-emoji emoji-id="5467538555158943525">💭</tg-emoji> <b>Your Profile</b> <tg-emoji emoji-id="5456343263340405032">🛍</tg-emoji>\n━━━━━━━━━━━━━━━\n<tg-emoji emoji-id="6276090299232031662">✅</tg-emoji> <b>ID:</b> ${userToDisplay.telegramId}\n\n<tg-emoji emoji-id="5201692367437974073">💵</tg-emoji> <b>Balance:</b> ${balanceUSD}$\n\n<tg-emoji emoji-id="5348256365477382384">⭐️</tg-emoji> <b>Purchased pcs:</b> ${userPurchases} pcs\n\n<tg-emoji emoji-id="5805188079148863343">🕒</tg-emoji> <b>Registration:</b> ${regDate}`, {
            reply_markup: keyboard,
            parse_mode: 'HTML'
          });
        }
      } else if (normalizedText?.includes(supportBtnText)) {
        const supportContact = (await storage.getSetting('SUPPORT_CONTACT'))?.value || 'rochana_imesh';
        const cleanUsername = supportContact.replace('@', '');
        targetBot.sendMessage(chatId, `<tg-emoji emoji-id="5461151367559141950">📩</tg-emoji> <b>For support, please contact us below:</b>`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: `💬 ${supportBtnText}`, url: `https://t.me/${cleanUsername}` }
            ]]
          }
        });
      } else if (normalizedText === '❓ FAQ') {
        const userName = tgUser?.firstName || 'User';
        const supportUsernameSetting = await storage.getSetting("SUPPORT_USERNAME");
        const supportUsername = supportUsernameSetting?.value || "@rochana_imesh";

        const rulesMessage = `<tg-emoji emoji-id="5413554183502572090">👋</tg-emoji> <b>Welcome, ${userName}</b> <tg-emoji emoji-id="5413554183502572090">✨</tg-emoji>\n\n` +
          `<tg-emoji emoji-id="5213181173026533794">⚠️</tg-emoji> <b>STORE RULES – PLEASE READ BEFORE BUYING</b> <tg-emoji emoji-id="5213181173026533794">⚠️</tg-emoji>\n\n` +
          `<tg-emoji emoji-id="5220091753930959575">1️⃣</tg-emoji> <b>Login Warranty Included</b>\n` +
          `You will receive a 100% working account at the time of purchase.\n` +
          `<tg-emoji emoji-id="6010111371251815589">⏱️</tg-emoji> <i>Checking time: 10–30 minutes after delivery.</i>\n\n` +
          `<tg-emoji emoji-id="5220041227935690133">2️⃣</tg-emoji> <b>Stay Safe & Secure</b>\n` +
          `Always use quality proxies and a proper fingerprint/anti-detect browser to avoid any security issues.\n\n` +
          `<tg-emoji emoji-id="5220224743298312689">3️⃣</tg-emoji> <b>User Responsibility</b>\n` +
          `We are not responsible for any actions taken after purchase.\n` +
          `Account usage is fully under the buyer’s responsibility.\n\n` +
          `<tg-emoji emoji-id="4958734459869332468">💯</tg-emoji> <b>Follow the rules, stay secure, and enjoy your purchase!</b> <tg-emoji emoji-id="4958734459869332468">💯</tg-emoji>\n\n` +
          `<tg-emoji emoji-id="5341498088408234504">⛱️</tg-emoji> <b>Need help or have questions?</b>\n` +
          `<tg-emoji emoji-id="5282843764451195532">🎗️</tg-emoji> <b>Contact us:</b> <tg-emoji emoji-id="5461151367559141950">💌</tg-emoji> ${supportUsername}`;

        targetBot.sendMessage(chatId, rulesMessage, { parse_mode: 'HTML' });
      } else if (tgUser?.lastAction?.startsWith('awaiting_quantity_')) {
        const productId = parseInt(tgUser.lastAction.split('_')[2]);
        const quantity = parseInt(normalizedText || "0");

        // Basic validation outside tx
        if (isNaN(quantity) || quantity <= 0) return targetBot.sendMessage(chatId, "❌ Please enter a valid number.");

        try {
          const result = await db.transaction(async (tx) => {
            // 1. Get user and product inside transaction
            const user = await tx.query.telegramUsers.findFirst({
              where: eq(telegramUsers.id, tgUser.id)
            });
            const product = await tx.query.products.findFirst({
              where: eq(products.id, productId)
            });

            if (!user || !product) throw new Error("Product or User not found.");

            const totalPrice = product.price * quantity;

            // 2. Atomic Balance check and deduction
            const [updatedUser] = await tx
              .update(telegramUsers)
              .set({
                balance: sql`${telegramUsers.balance} - ${totalPrice}`
              })
              .where(and(eq(telegramUsers.id, user.id), gte(telegramUsers.balance, totalPrice)))
              .returning();

            if (!updatedUser) throw new Error("Insufficient balance");

            // 3. Stock check and selection inside transaction
            const availableCredentials = await tx.query.credentials.findMany({
              where: and(eq(credentials.productId, productId), eq(credentials.status, 'available')),
              limit: quantity
            });

            if (availableCredentials.length < quantity) {
              throw new Error(`Sorry, only ${availableCredentials.length} Pcs remaining.`);
            }

            // 4. Mark credentials as sold and create orders
            for (const cred of availableCredentials) {
              await tx.update(credentials)
                .set({ status: 'sold' })
                .where(eq(credentials.id, cred.id));

              await tx.insert(orders).values({
                telegramUserId: user.id,
                productId: product.id,
                credentialId: cred.id,
                status: 'completed'
              });
            }

            // 5. Clear last action
            await tx.update(telegramUsers)
              .set({ lastAction: null, lastMessageId: null })
              .where(eq(telegramUsers.id, user.id));

            return { product, availableCredentials, totalPrice };
          });

          // 6. Success Response
          let productName = result.product.name.replace(/🇱🇰/g, '<tg-emoji emoji-id="5224277294050192388">🇱🇰</tg-emoji>');
          productName = productName.replace(/\bAWS\b/gi, '<tg-emoji emoji-id="5785025630055700143">☁️</tg-emoji> AWS');

          const itemsText = result.availableCredentials.map((c, index) => `<b>${(index + 1).toString().padStart(2, '0')}.</b>\n${c.content}`).join('\n\n');

          await targetBot.sendMessage(chatId, `<tg-emoji emoji-id="6276090299232031662">✅</tg-emoji> <b>Purchase successful!</b> <tg-emoji emoji-id="5431411862950388510">🙏</tg-emoji>\n\n<b>Product:</b> ${productName}\n<b>Quantity:</b> ${quantity}\n<b>Total:</b> $${(result.totalPrice / 100).toFixed(2)}\n\n<b>Your items:</b>\n\n${itemsText}`, { parse_mode: 'HTML' });

        } catch (err: any) {
          console.error('Normal purchase error:', err);
          if (err.message === "Insufficient balance") {
            // Recalculate price for the message since it's a known product
            const product = await storage.getProduct(parseInt(tgUser.lastAction!.split('_')[2]));
            const quantity = parseInt(normalizedText || "0");
            const totalPrice = (product?.price || 0) * quantity;
            
            const errorMsg = `<tg-emoji emoji-id="5215209935188534658">❌</tg-emoji> <b>Insufficient Balance!</b>\n\n` +
              `Your current balance is <b>$${(tgUser.balance / 100).toFixed(2)}</b>, but this purchase costs <b>$${(totalPrice / 100).toFixed(2)}</b>.\n\n` +
              `Please top up your account to continue. <tg-emoji emoji-id="5231102735817918643">💸</tg-emoji>`;

            await targetBot.sendMessage(chatId, errorMsg, {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[{ text: '💰 Add Now (Top-up)', callback_data: 'add_funds' }]]
              }
            });
          } else {
            await targetBot.sendMessage(chatId, `❌ Purchase failed: ${err.message}`);
          }
          // Also clear the last action if it was a real logic error
          await storage.updateTelegramUser(tgUser.id, { lastAction: null });
        }

        // Delete the prompt and user input
        try {
          if (tgUser.lastMessageId) {
            await targetBot.deleteMessage(chatId, tgUser.lastMessageId);
          }
          await targetBot.deleteMessage(chatId, msg.message_id);
        } catch (e) { }
      } else if (tgUser?.lastAction === 'awaiting_cryptomus_amount') {
        const amount = parseFloat(normalizedText || "0");

        // Delete prompt and user input
        try {
          if (tgUser.lastMessageId) {
            await targetBot.deleteMessage(chatId, tgUser.lastMessageId);
          }
          await targetBot.deleteMessage(chatId, msg.message_id);
        } catch (e) { }

        if (isNaN(amount) || amount <= 0) {
          targetBot.sendMessage(chatId, "❌ Invalid amount. Please enter a number.");
          return;
        }

        const apiKey = (await storage.getSetting('CRYPTOMUS_API_KEY'))?.value;
        const merchantId = (await storage.getSetting('CRYPTOMUS_MERCHANT_ID'))?.value;

        if (!apiKey || !merchantId) {
          targetBot.sendMessage(chatId, "❌ Cryptomus is not configured by admin.");
          return;
        }

        try {
          const orderId = crypto.randomBytes(12).toString('hex');
          const host = process.env.NODE_ENV === 'production'
            ? 'cloudshopplatform.site'
            : 'localhost:5000';

          // Amount Locking: Check for existing pending payment with same amount
          const existingPending = await storage.getPendingPaymentByAmount(tgUser.id, Math.round(amount * 100));
          if (existingPending) {
            return targetBot.sendMessage(chatId, `⚠️ You already have a pending $${amount} payment. Please pay that one first or wait for it to expire (1 hour).`);
          }

          const sign = crypto.createHash('md5').update(Buffer.from(JSON.stringify({
            amount: amount.toString(),
            currency: 'USD',
            order_id: orderId,
            url_callback: `https://${host}/api/payments/webhook`
          })).toString('base64') + apiKey).digest('hex');

          const response = await axios.post('https://api.cryptomus.com/v1/payment', {
            amount: amount.toString(),
            currency: 'USD',
            order_id: orderId,
            url_callback: `https://${host}/api/payments/webhook`
          }, {
            headers: {
              'merchant': merchantId,
              'sign': sign
            }
          });

          if (response.data.result) {
            const paymentData = response.data.result;
            const newPayment = await storage.createPayment({
              telegramUserId: tgUser.id,
              amount: Math.round(amount * 100),
              paymentMethod: 'cryptomus',
              status: 'pending',
              cryptomusUuid: paymentData.uuid
            });

            await storage.updateTelegramUser(tgUser.id, { lastAction: null });

            const responseMsg = `💰 Top-up: Cryptomus\n` +
              `➖➖➖➖➖➖➖➖➖➖\n` +
              `▪️ To recharge, click on the button below \n` +
              `Go to payment and pay the invoice issued to you\n` +
              `▪️ You have 5 hours to pay your bill\n` +
              `▪️ Top-up amount: ${amount}$\n` +
              `➖➖➖➖➖➖➖➖➖➖\n` +
              `⚠️ After payment, click on Check payment`;

            targetBot.sendMessage(chatId, responseMsg, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🌀 Go to payment', url: paymentData.url }],
                  [{ text: '🔄 Check payment', callback_data: `check_payment_${newPayment.id}` }]
                ]
              }
            });
          } else {
            throw new Error("Invalid response from Cryptomus");
          }
        } catch (err) {
          console.error('Cryptomus creation error:', err);
          targetBot.sendMessage(chatId, "❌ Failed to create Cryptomus invoice. Please try again later.");
        }
      } else if (tgUser?.lastAction === 'awaiting_binance_deposit_amount' || tgUser?.lastAction === 'awaiting_bybit_deposit_amount') {
        const amount = parseFloat(normalizedText || "0");

        // Delete prompt and user input
        try {
          if (tgUser.lastMessageId) {
            await targetBot.deleteMessage(chatId, tgUser.lastMessageId);
          }
          await targetBot.deleteMessage(chatId, msg.message_id);
        } catch (e) { }

        if (isNaN(amount) || amount <= 0) {
          targetBot.sendMessage(chatId, "❌ Invalid amount. Please enter a number.");
          return;
        }

        const method = tgUser.lastAction === 'awaiting_binance_deposit_amount' ? 'Binance' : 'Bybit';
        const payIdKey = method === 'Binance' ? 'BINANCE_PAY_ID' : 'BYBIT_PAY_ID';
        const payId = (await storage.getSetting(payIdKey))?.value || "Not Set";

        // Amount Locking: Check for existing pending payment with same amount
        const existingPending = await storage.getPendingPaymentByAmount(tgUser.id, Math.round(amount * 100));
        if (existingPending) {
          await storage.updateTelegramUserByChatId(chatId.toString(), { lastAction: null });
          return targetBot.sendMessage(chatId, `⚠️ You already have a pending $${amount} payment for ${method}. Please pay that one first or wait for it to expire (1 hour).`);
        }

        await storage.updateTelegramUserByChatId(chatId.toString(), { lastAction: null });

        const payment = await storage.createPayment({
          telegramUserId: tgUser.id,
          amount: Math.round(amount * 100),
          paymentMethod: method.toLowerCase(),
          status: 'pending'
        });

        const response = `<tg-emoji emoji-id="5388622778817589921">💰</tg-emoji> <b>Top-up: ${method}</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `<tg-emoji emoji-id="6276090299232031662">🆔</tg-emoji> ${method} Pay ID: <code>${payId}</code>\n` +
          `<tg-emoji emoji-id="5231102735817918643">💵</tg-emoji> Transfer amount: <code>${amount}$</code>\n` +
          `<tg-emoji emoji-id="5334982154868783692">📝</tg-emoji> In Note: <code>${userId}</code>\n\n` +
          `<tg-emoji emoji-id="6327875123646829719">⚠️</tg-emoji> <b>IMPORTANT</b>\n` +
          `• Please transfer this <b>exact amount</b>.\n` +
          `• You <b>MUST</b> include your User ID in the Note field.\n` +
          `━━━━━━━━━━━━━━━\n` +
          `<tg-emoji emoji-id="6010111371251815589">⏳</tg-emoji> After payment, click on Check payment`;

        const keyboard = [
          [{ text: `📋 Copy ${method} Pay ID: ${payId}`, callback_data: `copy_payid_${payId}` }],
          [{ text: `📋 Copy User ID: ${userId}`, callback_data: `copy_userid_${userId}` }],
          [{ text: '🔄 Check payment', callback_data: `check_payment_${payment.id}` }]
        ];

        console.log(`Sending ${method} payment message with keyboard:`, JSON.stringify(keyboard));

        if (method === 'Binance') {
          const imagePath = path.resolve(process.cwd(), 'public/assets/binance_pay_new.png');
          console.log(`Checking for Binance Pay image at: ${imagePath}`);

          try {
            if (fs.existsSync(imagePath)) {
              console.log('Binance Pay image found, sending as stream...');
              const photoStream = fs.createReadStream(imagePath);
              targetBot.sendPhoto(chatId, photoStream, {
                caption: response,
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: keyboard
                }
              }).catch(err => {
                console.error('Failed to send Binance photo from stream:', err);
                targetBot.sendMessage(chatId, response, {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: keyboard
                  }
                });
              });
            } else {
              console.log('Binance Pay image NOT found at', imagePath);
              targetBot.sendMessage(chatId, response, {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: keyboard
                }
              });
            }
          } catch (fsErr) {
            console.error('File system error during Binance image check:', fsErr);
            targetBot.sendMessage(chatId, response, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: keyboard
              }
            });
          }
        } else {
          targetBot.sendMessage(chatId, response, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: keyboard
            }
          });
        }
      } else if (tgUser?.lastAction?.startsWith('awaiting_screenshot_') && msg.photo) {
        const parts = tgUser.lastAction.split('_');
        const method = parts[2];
        const amount = parts[3];
        await storage.createPayment({
          telegramUserId: tgUser.id,
          amount: parseFloat(amount) * 100,
          currency: 'USD',
          status: 'pending',
          paymentMethod: method,
          cryptomusUuid: msg.photo[msg.photo.length - 1].file_id
        });
        await storage.updateTelegramUser(tgUser.id, { lastAction: null });
        targetBot.sendMessage(chatId, `✅ Screenshot received! Deposit of $${amount} via ${method} is being reviewed.`);
      } else if (tgUser?.lastAction?.startsWith('awaiting_quantity_')) {
        const productId = parseInt(tgUser.lastAction.split('_')[2]);
        const quantity = parseInt(normalizedText || "0");
        const product = await storage.getProduct(productId);

        if (!product) return targetBot.sendMessage(chatId, "❌ Product not found.");
        if (isNaN(quantity) || quantity <= 0) return targetBot.sendMessage(chatId, "❌ Please enter a valid number.");

        const stock = await storage.getCredentialsByProduct(product.id);
        const availableCredentials = stock.filter(c => c.status === 'available');

        if (quantity > availableCredentials.length) {
          return targetBot.sendMessage(chatId, `❌ Sorry, only ${availableCredentials.length} Pcs available.`);
        }

        const totalPrice = product.price * quantity;
        if (tgUser.balance < totalPrice) {
          const errorMsg = `<tg-emoji emoji-id="5215209935188534658">❌</tg-emoji> <b>Insufficient Balance!</b>\n\n` +
            `Your current balance is <b>$${(tgUser.balance / 100).toFixed(2)}</b>, but this purchase costs <b>$${(totalPrice / 100).toFixed(2)}</b>.\n\n` +
            `Please top up your account to continue. <tg-emoji emoji-id="5231102735817918643">💸</tg-emoji>`;

          return targetBot.sendMessage(chatId, errorMsg, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '💰 Add Now (Top-up)', callback_data: 'add_funds' }]]
            }
          });
        }

        // Process purchase
        for (let i = 0; i < quantity; i++) {
          const credential = availableCredentials[i];
          await storage.createOrder({
            telegramUserId: tgUser.id,
            productId: product.id,
            credentialId: credential.id,
            status: 'completed'
          });
          await storage.markCredentialSold(credential.id);
        }

        await storage.updateTelegramUser(tgUser.id, {
          balance: tgUser.balance - totalPrice,
          lastAction: null
        });

        let productName = product.name.replace(/🇱🇰/g, '<tg-emoji emoji-id="5224277294050192388">🇱🇰</tg-emoji>');
        productName = productName.replace(/\bAWS\b/gi, '<tg-emoji emoji-id="5785025630055700143">☁️</tg-emoji> AWS');

        const items = availableCredentials.slice(0, quantity).map((c, index) => `<b>${(index + 1).toString().padStart(2, '0')}.</b>\n${c.content}`).join('\n\n');
        targetBot.sendMessage(chatId, `<tg-emoji emoji-id="6276090299232031662">✅</tg-emoji> <b>Purchase successful!</b> <tg-emoji emoji-id="5431411862950388510">🙏</tg-emoji>\n\n<b>Product:</b> ${productName}\n<b>Quantity:</b> ${quantity}\n<b>Total:</b> $${(totalPrice / 100).toFixed(2)}\n\n<b>Your items:</b>\n\n${items}`, { parse_mode: 'HTML' });
      }
    });

    const processedCallbacks = new Set<string>();
    targetBot.on('callback_query', async (query) => {
      try {
        const callbackId = query.id;
        if (processedCallbacks.has(callbackId)) return;
        processedCallbacks.add(callbackId);
        setTimeout(() => processedCallbacks.delete(callbackId), 10000);

        const chatId = query.message?.chat.id;
        const data = query.data;
        const userId = query.from?.id.toString();
        if (!chatId || !data || !userId) return;

      try {
        await targetBot.answerCallbackQuery(query.id);
      } catch (err) { }

      const tgUser = await storage.getTelegramUser(userId);
      if (!tgUser) return;

      // Option 2: Start fast countdown on any button interaction
      try {
        const activeOffers = await storage.getActiveSpecialOffers();
        if (tgUser?.lastOfferBroadcastId && activeOffers.length > 0) {
          startFastTimer(userId, activeOffers[0].id, tgUser.lastOfferBroadcastId);
        }
      } catch (err) {
        console.error("Error in fast timer trigger:", err);
      }

      if (data.startsWith('approve_dep_')) {
        const parts = data.split('_');
        const targetUserId = parts[2];
        const amount = parseFloat(parts[3]);
        const targetUser = await storage.getTelegramUser(targetUserId);
        if (targetUser) {
          await storage.updateTelegramUser(Number(targetUserId), { balance: targetUser.balance + Math.round(amount * 100) });
          targetBot.sendMessage(targetUser.telegramId, `✅ Your deposit of $${amount.toFixed(2)} has been approved!`);
          targetBot.sendMessage(chatId, `✅ Approved deposit for ${targetUserId}`);
        }
      } else if (data.startsWith('reject_dep_')) {
        const targetUserId = data.split('_')[2];
        const targetUser = await storage.getTelegramUser(targetUserId);
        if (targetUser) {
          targetBot.sendMessage(targetUser.telegramId, `❌ Your deposit has been rejected.`);
          targetBot.sendMessage(chatId, `❌ Rejected deposit for ${targetUserId}`);
        }
      } else if (data.startsWith('cat_')) {
        const category = data.substring(4);
        const products = await storage.getProducts();
        const categoryProducts = products.filter(p => p.type === category && p.status === 'available');

        // Delete the "Select the product you need" message
        try {
          if (query.message) {
            await targetBot.deleteMessage(chatId, query.message.message_id);
          }
        } catch (err) { }

        if (categoryProducts.length === 0) {
          targetBot.sendMessage(chatId, `No products available in ${category}.`);
          return;
        }

        const keyboard = [];
        for (const p of categoryProducts) {
          const stock = await storage.getCredentialsByProduct(p.id);
          const availableStock = stock.filter(c => c.status === 'available').length;
          if (availableStock > 0) {
            keyboard.push([{
              text: `${p.name} - $${(p.price / 100).toFixed(2)} | ${availableStock} Pcs`,
              callback_data: `prod_${p.id}`
            }]);
          }
        }

        if (keyboard.length === 0) {
          targetBot.sendMessage(chatId, `Sorry, all products in ${category} are currently out of stock.`);
          return;
        }

        let catIcon = '';
        const catLower = category.toLowerCase();
        if (catLower.includes('aws')) catIcon = '<tg-emoji emoji-id="5785025630055700143">☁️</tg-emoji> ';
        else if (catLower.includes('digital ocean') || catLower.includes('digitalocean')) catIcon = '<tg-emoji emoji-id="6235413342576450502">💧</tg-emoji> ';
        else if (catLower.includes('azure')) catIcon = '<tg-emoji emoji-id="6235420094265037090">☁️</tg-emoji> ';
        else if (catLower.includes('kamatera')) catIcon = '<tg-emoji emoji-id="6235239937566838722">☁️</tg-emoji> ';

        targetBot.sendMessage(chatId, `${catIcon} <b>${category}</b>\n\nSelect the product you need <tg-emoji emoji-id="5231102735817918643">🛍</tg-emoji>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
      } else if (data.startsWith('copy_userid_')) {
        const userIdToCopy = data.substring(12);
        await targetBot.sendMessage(chatId, `<tg-emoji emoji-id="6276090299232031662">🆔</tg-emoji> <b>User ID sent!</b> You can now long-press to copy it. <tg-emoji emoji-id="5231102735817918643">📋</tg-emoji>`, { parse_mode: 'HTML' });
        targetBot.sendMessage(chatId, `<code>${userIdToCopy}</code>`, { parse_mode: 'HTML' });
      } else if (data.startsWith('copy_payid_')) {
        const payIdToCopy = data.substring(11);
        await targetBot.sendMessage(chatId, `<tg-emoji emoji-id="6276090299232031662">🆔</tg-emoji> <b>Pay ID sent!</b> You can now long-press to copy it. <tg-emoji emoji-id="5231102735817918643">📋</tg-emoji>`, { parse_mode: 'HTML' });
        targetBot.sendMessage(chatId, `<code>${payIdToCopy}</code>`, { parse_mode: 'HTML' });
      } else if (data.startsWith('prod_')) {
        const productId = parseInt(data.substring(5));
        const product = await storage.getProduct(productId);
        if (!product) return targetBot.sendMessage(chatId, "Product not found.");

        // Delete the "Products in Category" message
        try {
          if (query.message) {
            await targetBot.deleteMessage(chatId, query.message.message_id);
          }
        } catch (err) { }

        const stock = await storage.getCredentialsByProduct(product.id);
        const availableStock = stock.filter(c => c.status === 'available').length;

        if (availableStock === 0) {
          return targetBot.sendMessage(chatId, "❌ Sorry, this product is out of stock.");
        }

        const prompt = await targetBot.sendMessage(chatId, `How many ${product.name} would you like to buy? (Max: ${availableStock})`);
        await storage.updateTelegramUser(parseInt(tgUser.id.toString()), {
          lastAction: `awaiting_quantity_${productId}`,
          lastMessageId: prompt?.message_id
        });
      } else if (data.startsWith('confirm_offer_')) {
        const chatIdStr = chatId.toString();
        if (confirmingOffers.has(chatIdStr)) return;
        confirmingOffers.add(chatIdStr);

        const offerId = parseInt(data.substring(14));
        const offer = await storage.getSpecialOffer(offerId);
        if (!offer) {
          confirmingOffers.delete(chatIdStr);
          return targetBot.answerCallbackQuery(query.id, { text: "❌ Offer not found." });
        }

        const product = await storage.getProduct(offer.productId);
        if (!tgUser || !product) {
          confirmingOffers.delete(chatIdStr);
          return;
        }

        try {
          const result = await db.transaction(async (tx) => {
            // 1. Double check and Deduct balance atomically
            const [updatedUser] = await tx
              .update(telegramUsers)
              .set({
                balance: sql`${telegramUsers.balance} - ${offer.price}`
              })
              .where(and(eq(telegramUsers.id, tgUser.id), gte(telegramUsers.balance, offer.price)))
              .returning();

            if (!updatedUser) {
              throw new Error("Insufficient balance");
            }

            // 2. Stock check and selection inside transaction
            const availableCredentials = await tx.query.credentials.findMany({
              where: and(eq(credentials.productId, product.id), eq(credentials.status, 'available')),
              limit: offer.bundleQuantity || 1
            });

            if (availableCredentials.length < (offer.bundleQuantity || 1)) {
              throw new Error(`Not enough stock. (Required: ${offer.bundleQuantity || 1}, Available: ${availableCredentials.length})`);
            }

            // 3. Mark credentials as sold and create orders
            for (const cred of availableCredentials) {
              await tx.update(credentials)
                .set({ status: 'sold' })
                .where(eq(credentials.id, cred.id));

              await tx.insert(orders).values({
                telegramUserId: tgUser.id,
                productId: product.id,
                credentialId: cred.id,
                status: 'completed'
              });
            }

            return { updatedUser, availableCredentials };
          });

          // 4. Success Response
          let successMsg = `<tg-emoji emoji-id="6276090299232031662">✅</tg-emoji> <b>Purchase Successful!</b> <tg-emoji emoji-id="5456343263340405032">🛍️</tg-emoji>\n\n` +
            `<tg-emoji emoji-id="5231102735817918643">🎁</tg-emoji> Product: <b>${offer.name}</b>\n` +
            `📦 Quantity: <b>${offer.bundleQuantity || 1} pcs</b>\n` +
            `<tg-emoji emoji-id="5201692367437974073">💵</tg-emoji> Price: <b>$${(offer.price / 100).toFixed(2)}</b>\n\n` +
            `<tg-emoji emoji-id="6276134137963222688">🔑</tg-emoji> <b>Your Credentials:</b>\n`;

          result.availableCredentials.forEach((c, index) => {
            const num = (index + 1).toString().padStart(2, '0');
            successMsg += `<b>Account ${num}:</b> <code>${c.content}</code>\n`;
          });

          successMsg += `\nThank you for shopping with us! <tg-emoji emoji-id="5456343263340405032">🛍️</tg-emoji>`;

          await targetBot.answerCallbackQuery(query.id, { text: "✅ Purchase Successful!" });
          confirmingOffers.delete(chatIdStr);

          await targetBot.editMessageText(successMsg, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'HTML'
          });

        } catch (err: any) {
          console.error('Special offer purchase error:', err);
          const errorText = err.message === "Insufficient balance"
            ? "❌ Insufficient balance to complete this purchase."
            : `❌ Purchase failed: ${err.message}`;

          await targetBot.answerCallbackQuery(query.id, { text: errorText, show_alert: true });
          confirmingOffers.delete(chatIdStr);
        }
        return;
      } else if (data === 'cancel_purchase') {
        // Clear confirmation lock
        if (tgUser) {
          await storage.updateTelegramUser(tgUser.id, { lastAction: null });
        }
        confirmingOffers.delete(chatId.toString());
        await targetBot.editMessageText("❌ Purchase cancelled.", {
          chat_id: chatId,
          message_id: query.message?.message_id
        });
        await targetBot.answerCallbackQuery(query.id);

        // Auto-delete after 5 seconds
        const msgIdToDelete = query.message?.message_id;
        if (msgIdToDelete) {
          setTimeout(async () => {
            try {
              await targetBot.deleteMessage(chatId, msgIdToDelete);
            } catch (err) {
              // Ignore errors if message is already deleted
            }
          }, 5000);
        }
        return;
      } else if (data === 'purchase_history') {
        const allOrders = await storage.getOrders();
        const userIdNum = tgUser?.id;
        const userOrders = allOrders.filter(o => o.telegramUserId === userIdNum);

        if (userOrders.length === 0) {
          targetBot.sendMessage(chatId, '📜 You haven\'t purchased anything yet.');
          return;
        }

        const keyboard = {
          inline_keyboard: [
            [{ text: '🛍 Last 10 Purchases', callback_data: 'history_last10' }],
            [{ text: '📜 Show All History', callback_data: 'history_all' }],
            [{ text: '🔙 Back', callback_data: 'profile_refresh' }]
          ]
        };

        const menuText = `<tg-emoji emoji-id="5334982154868783692">📊</tg-emoji> <tg-emoji emoji-id="6276090299232031662">📜</tg-emoji> <b>Purchase History Menu</b>\n\nPlease select an option below: <tg-emoji emoji-id="5231102735817918643">🎁</tg-emoji>`;

        await targetBot.sendMessage(chatId, menuText, {
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
      } else if (data === 'history_last10' || data === 'history_all') {
        const allOrders = await storage.getOrders();
        const userIdNum = tgUser?.id;
        // Filter and sort by oldest first (so newest arrive last in chat)
        const userOrders = allOrders
          .filter(o => o.telegramUserId === userIdNum)
          .sort((a, b) => a.id - b.id);

        const displayOrders = data === 'history_last10'
          ? userOrders.slice(-10)
          : userOrders;

        // Batch messages of 10
        for (let i = 0; i < displayOrders.length; i += 10) {
          const batch = displayOrders.slice(i, i + 10);
          let historyText = i === 0
            ? `<tg-emoji emoji-id="5334982154868783692">📜</tg-emoji> <b>Your Purchase History</b> (${data === 'history_last10' ? 'Last 10' : 'All'}):\n\n`
            : '';

          batch.forEach((order, index) => {
            historyText += `<b>${i + index + 1}.</b> <tg-emoji emoji-id="6276134137963222688">🛍</tg-emoji> <b>${order.product?.name || 'Unknown'}</b>\n<tg-emoji emoji-id="5201692367437974073">💰</tg-emoji> $${((order.product?.price || 0) / 100).toFixed(2)}\n<tg-emoji emoji-id="6276090299232031662">🔑</tg-emoji> <code>${order.credential?.content || 'N/A'}</code>\n\n`;
          });

          await targetBot.sendMessage(chatId, historyText, { parse_mode: 'HTML' });
        }
      } else if (data === 'special_offers') {
        const stopSpecialOfferTimer = (chatId: number) => {
          if (activeSpecialOfferTimers.has(chatId)) {
            clearInterval(activeSpecialOfferTimers.get(chatId)!);
            activeSpecialOfferTimers.delete(chatId);
          }
        };

        const sendOrEditOffers = async (chatId: number, messageId?: number) => {
          if (confirmingOffers.has(chatId.toString())) return; // Safety lock
          let offers = [];
          try {
            offers = await storage.getActiveSpecialOffers();
          } catch (err) {
            console.error("Error in special_offers handler:", err);
          }
          if (offers.length === 0) {
            stopSpecialOfferTimer(chatId);
            const emptyMsg = "😔 No special offers available right now.";
            if (messageId) {
              try {
                return await targetBot.editMessageText(emptyMsg, { chat_id: chatId, message_id: messageId });
              } catch (e) { }
            } else {
              try {
                return await targetBot.sendMessage(chatId, emptyMsg);
              } catch (e) { }
            }
          }

          const headerEmojiIds = [
            "6276128687649723695", "6275964744453068322", "6275873218699989657",
            "6275869662467069270", "6276120956708591159", "6276075885321786491",
            "6276045545672807753", "6273727139506295416", "6276107406086771779"
          ];

          const header = headerEmojiIds.map(id => `<tg-emoji emoji-id="${id}">🎁</tg-emoji>`).join('');

          const numEmojiMap: Record<string, string> = {
            "0": "6228712321716325542", "1": "6231028576104221771", "2": "6228508985079632140",
            "3": "6228892912206220866", "4": "6228651427670002796", "5": "6230754058974531742",
            "6": "6231061110481488717", "7": "6228541351953173776", "8": "6228898272325406140",
            "9": "6230968699965150268"
          };

          let text = `<tg-emoji emoji-id="5467538555158943525">💭</tg-emoji> <b>Special Offers (Bundle Deals)</b> <tg-emoji emoji-id="5456343263340405032">🛍</tg-emoji>\n━━━━━━━━━━━━━━━\n\n`;
          text += `${header}\n\n`;

          const keyboard = { inline_keyboard: [] as any[] };

          for (const offer of offers) {
            const priceUSD = (offer.price / 100).toFixed(2);
            text += `<b>${offer.name}</b>\n\n`;
            text += `<tg-emoji emoji-id="6276134137963222688">🎁</tg-emoji> Quantity: <b>${offer.bundleQuantity} pcs</b>\n`;
            text += `<tg-emoji emoji-id="5201692367437974073">💎</tg-emoji> Bundle Price: <b>$${priceUSD}</b>\n\n`;

            if (offer.expiresAt) {
              const diff = new Date(offer.expiresAt).getTime() - Date.now();
              if (diff > 0) {
                const totalSeconds = Math.floor(diff / 1000);
                const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
                const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
                const s = (totalSeconds % 60).toString().padStart(2, '0');

                text += `<tg-emoji emoji-id="5206715082582533386">🤩</tg-emoji> <b>Hurry! Expires In</b> <tg-emoji emoji-id="5206715082582533386">🤩</tg-emoji>\n`;
                const formatTimeDigit = (digit: string | undefined) => {
                  const d = digit || '0';
                  return `<tg-emoji emoji-id="${numEmojiMap[d] || numEmojiMap['0']}">🎁</tg-emoji>`;
                };

                text += `${formatTimeDigit(h[0])} ${formatTimeDigit(h[1])} <b>:</b> ${formatTimeDigit(m[0])} ${formatTimeDigit(m[1])} <b>:</b> ${formatTimeDigit(s[0])} ${formatTimeDigit(s[1])}\n`;
              }
            }

            if (offer.description) text += `<i>${offer.description}</i>\n`;
            text += `━━━━━━━━━━━━━━━\n\n`;

            keyboard.inline_keyboard.push([{ text: `🎁 Claim Your Offer ($${priceUSD})`, callback_data: `buy_offer_${offer.id}` }]);
          }

          keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'profile_refresh' }]);

          if (messageId) {
            try {
              await targetBot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: keyboard
              });
            } catch (err: any) {
              if (err.message && err.message.includes("message is not modified")) {
                // Ignore
              } else {
                console.error("Error editing special offers:", err);
                stopSpecialOfferTimer(chatId);
              }
            }
          } else {
            const sentMsg = await targetBot.sendMessage(chatId, text, {
              parse_mode: 'HTML',
              reply_markup: keyboard
            });
            return sentMsg;
          }
        };

        try {
          stopSpecialOfferTimer(chatId);
          const sent = await sendOrEditOffers(chatId);
          if (sent?.message_id) {
            const interval = setInterval(() => {
              sendOrEditOffers(chatId, sent.message_id);
            }, 1000);
            activeSpecialOfferTimers.set(chatId, interval);
          }
        } catch (err) {
          console.error("Critical error in special_offers bot logic:", err);
        }
      } else if (data.startsWith('buy_offer_')) {
        const offerId = parseInt(data.substring(10));
        const offer = await storage.getSpecialOffer(offerId);
        if (!offer || offer.status !== 'active') {
          return targetBot.answerCallbackQuery(query.id, { text: "⚠️ Offer not found or expired.", show_alert: true });
        }

        const currentTGUser = await storage.getTelegramUser(userId);
        if (!currentTGUser) return;

        if (currentTGUser.balance < offer.price) {
          await targetBot.answerCallbackQuery(query.id);
          const lowBalanceMsg = `<tg-emoji emoji-id="6298544405435387645">❌</tg-emoji> <b>Insufficient Balance!</b>\n\n` +
            `Your current balance is <b>$${(currentTGUser.balance / 100).toFixed(2)}</b>, but this offer costs <b>$${(offer.price / 100).toFixed(2)}</b>.\n\n` +
            `Please top up your account to continue. <tg-emoji emoji-id="5201692367437974073">💵</tg-emoji>`;

          return targetBot.sendMessage(chatId, lowBalanceMsg, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '💰 Add Now (Top-up)', callback_data: 'add_funds' }]]
            }
          });
        }

        // 2. Stock Check
        const stock = await storage.getCredentialsByProduct(offer.productId);
        const availableStock = stock.filter(c => c.status === 'available');
        if (availableStock.length < offer.bundleQuantity) {
          return targetBot.answerCallbackQuery(query.id, { text: `❌ Not enough stock for this bundle. (Required: ${offer.bundleQuantity}, Available: ${availableStock.length})`, show_alert: true });
        }

        // 3. Clear Tracking & Full Message Update (To stop Timers permanently for this message)
        // Also stop the interactive menu timer
        if (activeSpecialOfferTimers.has(chatId)) {
          clearInterval(activeSpecialOfferTimers.get(chatId)!);
          activeSpecialOfferTimers.delete(chatId);
        }

        await storage.updateTelegramUser(currentTGUser.id, {
          lastOfferBroadcastId: null, // This stops the Global Timer
          lastAction: `confirming_offer_${offerId}`
        });

        // Stop Fast Timer if exists
        if (activeSessionTimers.has(currentTGUser.telegramId)) {
          clearInterval(activeSessionTimers.get(currentTGUser.telegramId)!);
          activeSessionTimers.delete(currentTGUser.telegramId);
        }

        const confirmKeyboard = {
          inline_keyboard: [
            [{ text: '✅ Confirm Purchase', callback_data: `confirm_offer_${offerId}` }],
            [{ text: '❌ Cancel', callback_data: 'cancel_purchase' }]
          ]
        };

        const confirmText = `<tg-emoji emoji-id="6276134137963222688">🎁</tg-emoji> <b>${offer.name}</b>\n\n` +
          `<tg-emoji emoji-id="5201692367437974073">💎</tg-emoji> Bundle Price: <b>$${(offer.price / 100).toFixed(2)}</b>\n\n` +
          `Please confirm your purchase below: <tg-emoji emoji-id="5231102735817918643">🤍</tg-emoji>`;

        try {
          await targetBot.editMessageText(confirmText, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'HTML',
            reply_markup: confirmKeyboard
          });
          await targetBot.answerCallbackQuery(query.id);
        } catch (err) {
          await targetBot.sendMessage(chatId, confirmText, {
            parse_mode: 'HTML',
            reply_markup: confirmKeyboard
          });
          await targetBot.answerCallbackQuery(query.id);
        }
        return;
      } else if (data === 'add_funds') {
        try {
          if (query.message) {
            await targetBot.deleteMessage(chatId, query.message.message_id);
          }
        } catch (err) { }

        const binanceEnabled = (await storage.getSetting('PAYMENT_BINANCE_ENABLED'))?.value !== 'false';
        const bybitEnabled = (await storage.getSetting('PAYMENT_BYBIT_ENABLED'))?.value !== 'false';
        const cryptomusEnabled = (await storage.getSetting('PAYMENT_CRYPTOMUS_ENABLED'))?.value !== 'false';

        const keyboard = [];
        const mainRow = [];
        if (binanceEnabled) mainRow.push({ text: '💳 Binance', callback_data: 'payment_binance' });
        if (bybitEnabled) mainRow.push({ text: '💰 Bybit', callback_data: 'payment_bybit' });
        if (mainRow.length > 0) keyboard.push(mainRow);

        if (cryptomusEnabled) {
          keyboard.push([{ text: '🔐 Cryptomus', callback_data: 'payment_cryptomus' }]);
        }

        if (keyboard.length === 0) {
          targetBot.sendMessage(chatId, "⚠️ Sorry, no payment methods are currently available. Please contact support.");
          return;
        }

        targetBot.sendMessage(chatId, `<tg-emoji emoji-id="5201692367437974073">💰</tg-emoji> Select Payment Method:`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
      } else if (data === 'payment_binance' || data === 'payment_bybit') {
        try {
          if (query.message) {
            await targetBot.deleteMessage(chatId, query.message.message_id);
          }
        } catch (err) { }

        const method = data === 'payment_binance' ? 'Binance' : 'Bybit';

        // Delete any existing amount prompts before sending a new one
        try {
          const currentUser = await storage.getTelegramUserByChatId(chatId.toString());
          if (currentUser?.lastMessageId) {
            await targetBot.deleteMessage(chatId, currentUser.lastMessageId).catch(() => { });
          }
        } catch (err) { }

        const prompt = await targetBot.sendMessage(chatId, `<tg-emoji emoji-id="5296437653770608702">💰</tg-emoji> Enter amount for ${method} (USDT <tg-emoji emoji-id="5201692367437974073">💵</tg-emoji>):`, {
          parse_mode: 'HTML'
        });
        await storage.updateTelegramUserByChatId(chatId.toString(), {
          lastAction: `awaiting_${method.toLowerCase()}_deposit_amount`,
          lastMessageId: prompt?.message_id
        });
      } else if (data.startsWith('bybit_transferred_')) {
        const parts = data.split('_');
        const amount = parts[2];
        const paymentId = parts[3];
        await storage.updateTelegramUserByChatId(userId, { lastAction: `awaiting_bybit_hash_${amount}_${paymentId}` });
        targetBot.sendMessage(chatId, `💰 *Bybit Verification*\n\nPlease enter the *Transaction Hash* (Transfer ID) for your $${amount} payment:`, { parse_mode: 'Markdown' });
      } else if (data === 'payment_cryptomus') {
        try {
          if (query.message) {
            await targetBot.deleteMessage(chatId, query.message.message_id);
          }
        } catch (err) { }

        const prompt = await targetBot.sendMessage(chatId, `<tg-emoji emoji-id="5296437653770608702">💰</tg-emoji> Enter amount for Cryptomus deposit (USD <tg-emoji emoji-id="5201692367437974073">💵</tg-emoji>):`, {
          parse_mode: 'HTML'
        });
        await storage.updateTelegramUserByChatId(chatId.toString(), {
          lastAction: 'awaiting_cryptomus_amount',
          lastMessageId: prompt?.message_id
        });
      } else if (data.startsWith('check_payment_')) {
        const paymentId = parseInt(data.substring(14));
        const payment = await storage.getPayment(paymentId);

        if (!payment || payment.status !== 'pending') {
          try {
            await targetBot.answerCallbackQuery(query.id, {
              text: "❌ Payment not found, expired, or already processed.",
              show_alert: true
            });
          } catch (e) { }
          return;
        }

        // Expiration Check: 1 Hour
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (payment.createdAt && new Date(payment.createdAt) < oneHourAgo) {
          await storage.updatePayment(payment.id, { status: 'expired' });
          try {
            await targetBot.answerCallbackQuery(query.id, {
              text: "❌ This payment request has expired (1 hour limit). Please create a new one.",
              show_alert: true
            });
          } catch (e) { }
          return;
        }

        // Send "Checking payment..." message in chat
        let checkingMsg: TelegramBot.Message | undefined;
        try {
          // Get user from storage to get lastErrorMessageId
          const userForDelete = await storage.getTelegramUser(userId);
          if (userForDelete?.lastErrorMessageId) {
            await targetBot.deleteMessage(chatId, userForDelete.lastErrorMessageId).catch(() => { });
            await storage.updateTelegramUser(userForDelete.id, { lastErrorMessageId: null });
          }
          checkingMsg = await targetBot.sendMessage(chatId, `<tg-emoji emoji-id="6010111371251815589">⏳</tg-emoji> <b>Checking payment...</b> Please wait.`, { parse_mode: 'HTML' });
        } catch (e) { }

        try {
          if (payment.paymentMethod === 'binance') {
            const apiKey = (await storage.getSetting('BINANCE_API_KEY'))?.value;
            const secretKey = (await storage.getSetting('BINANCE_SECRET_KEY'))?.value;

            if (!apiKey || !secretKey) {
              if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
              return targetBot.answerCallbackQuery(query.id, {
                text: "⚠️ Automatic verification is not configured for Binance. Please contact support.",
                show_alert: true
              });
            }

            const timestamp = Date.now();
            const queryStr = `timestamp=${timestamp}`;
            const signature = crypto
              .createHmac('sha256', secretKey)
              .update(queryStr)
              .digest('hex');

            const response = await axios.get(`https://api.binance.com/sapi/v1/pay/transactions?${queryStr}&signature=${signature}`, {
              headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
              }
            });

            if (response.data && response.data.code === '000000' && Array.from(response.data.data).length > 0) {
              const transactions = response.data.data;
              const expectedAmount = (payment.amount / 100).toString();
              const userIdStr = tgUser.telegramId;

              // Get already processed external IDs for this user to avoid duplicate matching
              const processedExternalIds = (await db.select({ extId: payments.externalId })
                .from(payments)
                .where(and(eq(payments.telegramUserId, tgUser.id), eq(payments.status, 'completed'))))
                .map(p => p.extId);

              const match = transactions.find((tx: any) => {
                const txAmount = tx.amount;
                const txNote = tx.note || tx.memo || "";
                return txAmount === expectedAmount && txNote.includes(userIdStr) && !processedExternalIds.includes(tx.orderId);
              });

              if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });

              if (match) {
                // Check if this transaction has already been used for a payment
                const existingSuccess = await db.select().from(payments).where(and(eq(payments.externalId, match.orderId), eq(payments.status, 'completed'))).limit(1);
                if (existingSuccess.length > 0) {
                  return targetBot.answerCallbackQuery(query.id, {
                    text: "⚠️ This transaction has already been credited to your account.",
                    show_alert: true
                  });
                }

                await storage.updateTelegramUser(tgUser.id, {
                  balance: tgUser.balance + payment.amount
                });
                await storage.updatePayment(payment.id, {
                  status: 'completed',
                  externalId: match.orderId
                });
                targetBot.sendMessage(chatId, `<tg-emoji emoji-id="6276090299232031662">✅</tg-emoji> <b>Binance payment verified!</b> $${expectedAmount} has been added to your balance.`, { parse_mode: 'HTML' });
              } else {
                const failMsg = `<tg-emoji emoji-id="6298544405435387645">❌</tg-emoji> <b>Binance transaction not found.</b>\n\nPlease ensure you included your User ID in the Note field and transferred the exact amount. <tg-emoji emoji-id="6298544405435387645">❌</tg-emoji>`;
                const sentMsg = await targetBot.sendMessage(chatId, failMsg, { parse_mode: 'HTML' });
                if (sentMsg) {
                  await storage.updateTelegramUser(tgUser.id, { lastErrorMessageId: sentMsg.message_id });
                  // Auto delete after 15 seconds
                  setTimeout(() => {
                    targetBot.deleteMessage(chatId, sentMsg.message_id).catch(() => { });
                  }, 15000);
                }
              }
            } else {
              if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
              const failMsg = `<tg-emoji emoji-id="6298544405435387645">❌</tg-emoji> <b>Binance transaction not found.</b>\n\nPlease ensure you included your User ID in the Note field and transferred the exact amount. <tg-emoji emoji-id="6298544405435387645">❌</tg-emoji>`;
              const sentMsg = await targetBot.sendMessage(chatId, failMsg, { parse_mode: 'HTML' });
              if (sentMsg) {
                await storage.updateTelegramUser(tgUser.id, { lastErrorMessageId: sentMsg.message_id });
                // Auto delete after 15 seconds
                setTimeout(() => {
                  targetBot.deleteMessage(chatId, sentMsg.message_id).catch(() => { });
                }, 15000);
              }
            }
          } else if (payment.paymentMethod === 'bybit') {
            const apiKey = (await storage.getSetting('BYBIT_API_KEY'))?.value;
            const secretKey = (await storage.getSetting('BYBIT_SECRET_KEY'))?.value;

            if (!apiKey || !secretKey) {
              if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
              return targetBot.answerCallbackQuery(query.id, {
                text: "⚠️ Automatic verification is not configured for Bybit. Please contact support.",
                show_alert: true
              });
            }

            try {
              const timestamp = Date.now();
              const recvWindow = 5000;
              const queryStr = `coin=USDT&limit=50`;

              // Bybit V5 Signature for GET requests: timestamp + apiKey + recvWindow + query
              const signData = timestamp + apiKey + recvWindow + queryStr;
              const signature = crypto
                .createHmac('sha256', secretKey)
                .update(signData)
                .digest('hex');

              const response = await axios.get(`https://api.bybit.com/v5/asset/transfer/query-inter-transfer-list?${queryStr}`, {
                headers: {
                  'X-BAPI-API-KEY': apiKey,
                  'X-BAPI-SIGN': signature,
                  'X-BAPI-TIMESTAMP': timestamp.toString(),
                  'X-BAPI-RECV-WINDOW': recvWindow.toString(),
                }
              });

              if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });

              if (response.data && response.data.retCode === 0) {
                const transfers = response.data.result.list || [];
                const expectedAmount = (payment.amount / 100).toString();

                // Get already processed external IDs for this user
                const processedExternalIds = (await db.select({ extId: payments.externalId })
                  .from(payments)
                  .where(and(eq(payments.telegramUserId, tgUser.id), eq(payments.status, 'completed'))))
                  .map(p => p.extId);

                const match = transfers.find((tx: any) => {
                  return tx.amount === expectedAmount && tx.status === 'SUCCESS' && !processedExternalIds.includes(tx.transferId);
                });

                if (match) {
                  const existingSuccess = await db.select().from(payments).where(and(eq(payments.externalId, match.transferId), eq(payments.status, 'completed'))).limit(1);
                  if (existingSuccess.length > 0) {
                    return targetBot.answerCallbackQuery(query.id, {
                      text: "⚠️ This transaction has already been credited.",
                      show_alert: true
                    });
                  }

                  await storage.updateTelegramUser(tgUser.id, {
                    balance: tgUser.balance + payment.amount
                  });
                  await storage.updatePayment(payment.id, {
                    status: 'completed',
                    externalId: match.transferId
                  });
                  targetBot.sendMessage(chatId, `✅ Bybit payment verified! $${expectedAmount} added to balance.`);
                } else {
                  targetBot.sendMessage(chatId, "❌ Bybit transaction not found. Please ensure the transfer is completed.");
                }
              } else {
                targetBot.sendMessage(chatId, "❌ Error checking Bybit payment.");
              }
            } catch (err) {
              if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
              targetBot.sendMessage(chatId, "❌ Failed to connect to Bybit API.");
            }
          } else if (payment.paymentMethod === 'cryptomus') {
            const merchantId = (await storage.getSetting('CRYPTOMUS_MERCHANT_ID'))?.value;
            const apiKey = (await storage.getSetting('CRYPTOMUS_API_KEY'))?.value;

            if (!merchantId || !apiKey) {
              return targetBot.answerCallbackQuery(query.id, {
                text: "⚠️ Automatic verification is not configured for Cryptomus. Please contact support.",
                show_alert: true
              });
            }

            try {
              const sign = crypto.createHash('md5').update(Buffer.from(JSON.stringify({
                uuid: payment.cryptomusUuid
              })).toString('base64') + apiKey).digest('hex');

              const response = await axios.post('https://api.cryptomus.com/v1/payment/info', {
                uuid: payment.cryptomusUuid
              }, {
                headers: {
                  'merchant': merchantId,
                  'sign': sign
                }
              });

              if (response.data.result) {
                const status = response.data.result.status;
                if (status === 'paid' || status === 'paid_over') {
                  if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
                  await storage.updateTelegramUser(tgUser.id, {
                    balance: tgUser.balance + payment.amount
                  });
                  await storage.updatePayment(payment.id, { status: 'completed' });
                  targetBot.sendMessage(chatId, `✅ Cryptomus payment verified! $${(payment.amount / 100).toFixed(2)} has been added to your balance.`);
                } else if (status === 'process') {
                  if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
                  targetBot.sendMessage(chatId, "⏳ Payment is still processing. Please wait a few minutes and try again.");
                } else if (status === 'cancel' || status === 'fail') {
                  if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
                  await storage.updatePayment(payment.id, { status: 'failed' });
                  targetBot.sendMessage(chatId, "❌ Payment was cancelled or failed.");
                } else {
                  if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
                  targetBot.sendMessage(chatId, "❌ Payment was not found or is awaiting network confirmation. Try again later");
                }
              }
            } catch (err) {
              if (checkingMsg) await targetBot.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
              targetBot.sendMessage(chatId, "❌ Error checking Cryptomus payment status.");
            }
          }
        } catch (err) {
          if (checkingMsg) await targetBot.deleteMessage(chatId, (checkingMsg as any).message_id).catch(() => { });
          await targetBot.sendMessage(chatId, "❌ Error connecting to exchange API. Please contact support.");
        }
      }
    } catch (err) {
      console.error("Global Callback Listener 2 Error:", err);
    }
  });
};
initBot().catch(err => console.error("Initial bot setup failed:", err));

// Start Backup Scheduler
BackupService.startBackupScheduler().catch(err => console.error("Backup scheduler failed to start:", err));

  // Push Notification Routes
  app.get("/api/admin/push-key", isAuth, async (req, res) => {
    const { publicKey } = await initPushNotifications();
    res.json({ publicKey });
  });

  app.post("/api/admin/subscribe", isAuth, async (req, res) => {
    const { subscription } = req.body;
    console.log('[PUSH] Received subscription request from user:', req.session.userId);
    if (!subscription) {
      console.error('[PUSH] No subscription object provided');
      return res.status(400).json({ message: "Subscription required" });
    }
    await storage.savePushSubscription(req.session.userId!, subscription);
    console.log('[PUSH] Subscription saved successfully for user:', req.session.userId);
    res.sendStatus(201);
  });

  app.post("/api/admin/test-push", isAuth, async (req, res) => {
    console.log('[PUSH] Manual test trigger by user:', req.session.userId);
    await sendAdminPushNotification(
      'Test Alert',
      'This is a test notification from Shopeefy!',
      '/settings'
    );
    res.json({ success: true });
  });

  return httpServer;
}
