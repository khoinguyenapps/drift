import dotenv from "dotenv";
import { Connection, Keypair } from "@solana/web3.js";
import {
  BulkAccountLoader,
  DriftClient,
  OptionalOrderParams,
  OrderType,
  PerpMarkets,
  PositionDirection,
  User,
  Wallet,
  loadKeypair,
  UserAccount,
} from "@drift-labs/sdk";
import { SendTransactionError } from "@solana/web3.js";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY as string;

// configuration
const BOT_CONFIG = {
  marketIndex: 1, // 0: USDC, 1: SOL
  orderSize: 0.1, // 0.1 SOL order size
  price: 165.35, // TODO: get price from API
  depositAmount: 0.5, // Deposit 0.5 SOL

  useDelegate: false, // Toggle delegate functionality ON/OFF
  delegateTradingAccountId: 0, // Trading account ID for delegate

  network: "devnet", // "devnet" or "mainnet-beta"
};

const getTokenInfo = async (symbol: string) => {
  const markets =
    BOT_CONFIG.network === "devnet"
      ? PerpMarkets["devnet"]
      : PerpMarkets["mainnet-beta"];

  const tokenInfo = markets.find(
    (market: any) => market.baseAssetSymbol === symbol
  );

  if (!tokenInfo) {
    throw new Error(`Token info for ${symbol} not found`);
  }
  return tokenInfo;
};

const getBalance = async (connection: Connection, wallet: Wallet) => {
  const lamportsBalance = await connection.getBalance(wallet.publicKey);
  console.log(`Wallet Balance: ${lamportsBalance / 1e9} SOL`);
  return lamportsBalance;
};

const getTradingAccountBalance = async (driftClient: DriftClient, user: User) => {
  try {
    console.log("Get trading account balance...");
    try {
      const solPosition = user.getSpotPosition(BOT_CONFIG.marketIndex); // SOL market index
      if (solPosition) {
        const cumulativeDeposits =
          solPosition.cumulativeDeposits.toNumber() / 1e9;
        const scaledBalance = solPosition.scaledBalance.toNumber() / 1e9;
        return cumulativeDeposits - scaledBalance;
      }
    } catch (error) {
      console.log(`- Error getting user spot position: ${error}`);
    }

    return 0;
  } catch (error) {
    console.error("Error checking trading account balance:", error);
    return null;
  }
};

const depositToTradingAccount = async (
  driftClient: DriftClient,
  amount: number
) => {
  try {
    console.log(`Depositing ${amount} SOL to trading account...`);

    const depositAmount = driftClient.convertToSpotPrecision(
      BOT_CONFIG.marketIndex,
      amount
    );
    const associatedTokenAccount = await driftClient.getAssociatedTokenAccount(
      BOT_CONFIG.marketIndex
    );

    const txSig = await driftClient.deposit(
      depositAmount,
      BOT_CONFIG.marketIndex,
      associatedTokenAccount
    );

    console.log("✅ Deposit successful!");
    console.log("Transaction signature:", txSig);
    return txSig;
  } catch (error) {
    console.error("❌ Failed to deposit:", error);
    throw error;
  }
};

const generateDelegateKeypair = () => {
  const newSolanaAccount = Keypair.generate();
  console.log(
    "Delegate account address:",
    newSolanaAccount.publicKey.toBase58()
  );
  console.log(
    "Delegate account secret:",
    Buffer.from(newSolanaAccount.secretKey).toString("hex")
  );
  return newSolanaAccount;
};

const setupDelegate = async (
  driftClient: DriftClient,
  accountId: number
) => {
  try {
    console.log("Setting up delegate account...");

    // Generate new delegate keypair
    const delegateAccount = generateDelegateKeypair();

    // Update user delegate
    await driftClient.updateUserDelegate(
      delegateAccount.publicKey,
      accountId
    );
    console.log("✅ Delegate account updated successfully!");

    return delegateAccount;
  } catch (error) {
    console.error("❌ Failed to setup delegate:", error);
    throw error;
  }
};

const createDelegateClient = async (
  connection: Connection,
  delegateAccount: Keypair,
  mainWallet: Wallet,
  bulkAccountLoader: BulkAccountLoader
) => {
  try {
    console.log("🔐 Creating delegate client...");

    const delegateDriftClient = new DriftClient({
      connection,
      wallet: new Wallet(delegateAccount),
      env: BOT_CONFIG.network as any,
      accountSubscription: {
        type: "polling",
        accountLoader: bulkAccountLoader,
      },
      authority: mainWallet.publicKey, // Use main wallet as authority
      includeDelegates: true, // Include delegate accounts
    });

    await delegateDriftClient.subscribe();
    console.log("✅ Delegate client created and subscribed!");

    return delegateDriftClient;
  } catch (error) {
    console.error("❌ Failed to create delegate client:", error);
    throw error;
  }
};

const placeTrade = async (driftClient: DriftClient, user: User) => {
  try {
    const tokenInfo = await getTokenInfo("SOL");
    console.log(
      `Trading ${tokenInfo.baseAssetSymbol} (Market Index: ${tokenInfo.marketIndex})`
    );

    // Check trading account balance
    console.log("🔍 Checking trading balance before trading...");
    const tradingAccountBalance = await getTradingAccountBalance(driftClient, user);

    const requiredCollateral = BOT_CONFIG.orderSize * 2;
    if (!tradingAccountBalance || tradingAccountBalance < requiredCollateral) {
      console.log(
        `Insufficient SOL in trading account. Need at least ${requiredCollateral} SOL`
      );
      console.log("Depositing to trading account...");
      await depositToTradingAccount(driftClient, BOT_CONFIG.depositAmount);

      console.log("Waiting for deposit confirmation...");
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Check trading account balance again after deposit
      console.log("Checking trading account balance after deposit...");
      const newTradingAccountBalance = await getTradingAccountBalance(
        driftClient,
        user
      );
      if (newTradingAccountBalance && newTradingAccountBalance < requiredCollateral) {
        throw new Error(
          `Still insufficient balance in trading account after deposit`
        );
      }
    } else {
      console.log("Sufficient SOL in trading account for futures trading");
    }

    const orderParams: OptionalOrderParams = {
      orderType: OrderType.MARKET, // MARKET | LIMIT
      marketIndex: tokenInfo.marketIndex,
      direction: PositionDirection.LONG, // LONG | SHORET
      baseAssetAmount: driftClient.convertToPerpPrecision(BOT_CONFIG.orderSize),
      price: driftClient.convertToPricePrecision(BOT_CONFIG.price),
    };

    console.log("Order Params:", {
      orderType: orderParams.orderType,
      marketIndex: orderParams.marketIndex,
      direction: orderParams.direction,
      baseAssetAmount: orderParams.baseAssetAmount.toNumber() / 1e9,
      price: orderParams.price?.toNumber() || 0 / 1e9,
    });

    const result = await driftClient.placePerpOrder(orderParams);
    console.log("✅ Create order successfully!");
    console.log("Order Result:", result);

    return result;
  } catch (e) {
    if (e instanceof SendTransactionError) {
      console.error("❌ Transaction failed:");
      console.error("Simulation Logs:", e.logs);

      if (e.logs && e.logs.some((log) => log.includes("OrderAmountTooSmall"))) {
        console.log("💡 Order size too small");
      } else {
        console.error("❌ Full error:", e);
      }
    }

    throw e;
  }
};

const main = async () => {
  console.log("🤖 Starting...");
  console.log("🔧 Configuration:", { ...BOT_CONFIG });

  // Create connection to Solana
  const connection = new Connection(
    `https://api.${BOT_CONFIG.network}.solana.com`
  );

  console.log(`Connected to Solana ${BOT_CONFIG.network}`);

  // Initialize main wallet
  const mainWallet = new Wallet(loadKeypair(PRIVATE_KEY));
  console.log("Main wallet address:", mainWallet.publicKey.toBase58());

  // Check balance
  const balance = await getBalance(connection, mainWallet);
  if (balance < 0.1) {
    console.error("❌ Insufficient balance. Need at least 0.1 SOL");
    return;
  }

  // Initialize bulk account loader
  const bulkAccountLoader = new BulkAccountLoader(
    connection,
    "confirmed",
    1000
  );

  // Initialize main Drift client
  const mainDriftClient = new DriftClient({
    connection,
    wallet: mainWallet,
    env: BOT_CONFIG.network as any,
    accountSubscription: {
      type: "polling",
      accountLoader: bulkAccountLoader,
    },
  });

  await mainDriftClient.subscribe();
  console.log("Main Drift client subscribed");

  let userAccount: UserAccount | undefined;

  if (!mainDriftClient.hasUser()) {
    console.log("User account does not exist. Creating new user account...");
    try {
      const txSig = await mainDriftClient.initializeUserAccount(0);
      console.log("✅ User account created successfully!");

      await new Promise((resolve) => setTimeout(resolve, 5000));

      userAccount = mainDriftClient.getUserAccount();
      console.log("User account", userAccount ? "exists" : "still not found");

      if (!userAccount) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        userAccount = mainDriftClient.getUserAccount();
        console.log("User account", userAccount ? "exists" : "still not found");

        if (!userAccount) {
          throw new Error("User account still not found after");
        }
      }
      console.log("✅ User account created");
    } catch (error) {
      console.error("❌ Failed to create user account:", error);
      throw error;
    }
  } else {
    console.log("✅ User account already exists");
  }

  const userAccountPublicKey = await mainDriftClient.getUserAccountPublicKey();
  console.log("🔍 User account public key:", userAccountPublicKey.toBase58());

  // Initialize user
  const user = new User({
    driftClient: mainDriftClient,
    userAccountPublicKey: userAccountPublicKey,
    accountSubscription: {
      type: "polling",
      accountLoader: bulkAccountLoader,
    },
  });
  await user.subscribe();
  console.log("👤 User account subscribed");

  // Setup delegate if enabled
  let delegateAccount: Keypair | null = null;
  let delegateDriftClient: DriftClient | null = null;

  if (BOT_CONFIG.useDelegate) {
    console.log("Delegate mode enabled...");
    delegateAccount = await setupDelegate(
      mainDriftClient,
      BOT_CONFIG.delegateTradingAccountId
    );
    delegateDriftClient = await createDelegateClient(
      connection,
      delegateAccount,
      mainWallet,
      bulkAccountLoader
    );
  } else {
    console.log("👤 Direct trading mode (no delegate)");
  }

  const tradingClient = BOT_CONFIG.useDelegate
    ? delegateDriftClient!
    : mainDriftClient;

  await placeTrade(tradingClient, user);

  console.log("✅ Bot execution completed!");
};

main()
  .then(() => {
    console.log("🎉 Bot finished successfully!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("💥 Bot failed:", err);
    process.exit(1);
  });
