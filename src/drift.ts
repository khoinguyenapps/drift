import dotenv from "dotenv";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  BulkAccountLoader,
  DriftClient,
  OptionalOrderParams,
  OrderType,
  PerpMarkets,
  PositionDirection,
  User,
  Wallet,
  initialize,
  loadKeypair,
} from "@drift-labs/sdk";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { SendTransactionError } from "@solana/web3.js";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY as string;

export const getTokenAddress = (
  mintAddress: string,
  userPubKey: string
): Promise<PublicKey> => {
  return getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    new PublicKey(userPubKey)
  );
};

const getUserAccountPublicKey = async (
  driftClient: DriftClient,
  subAccountId: number
) => {
  try {
    const userAccountPublicKey = await driftClient.getUserAccountPublicKey(
      subAccountId
    );
    return userAccountPublicKey;
  } catch (error) {
    return null;
  }
};

const getTokenInfo = async (symbol: string) => {
  const tokenInfo = PerpMarkets["devnet"].find(
    (market) => market.baseAssetSymbol === symbol
  );
  if (!tokenInfo) {
    throw new Error(`Token info for ${symbol} not found`);
  }
  return tokenInfo;
};

const generateDelegateKeypair = () => {
  const newSolanaAccount = Keypair.generate();
  console.log(
    "Delegate account address: ",
    newSolanaAccount.publicKey.toBase58()
  );
  console.log(
    "Delegate account secret: ",
    Buffer.from(newSolanaAccount.secretKey).toString("hex")
  );
  return newSolanaAccount;
};

const initDelegateAccount = () => {
  const DELEGATE_SECRET_KEY = "";
  const secretKey = Uint8Array.from(Buffer.from(DELEGATE_SECRET_KEY, "hex"));
  const keypair = Keypair.fromSecretKey(secretKey);
  console.log("Delegate account address: ", keypair.publicKey.toBase58());
  return keypair;
};

const main = async () => {
  // Create a connection to the Solana
  const connection = new Connection("https://api.devnet.solana.com");

  const sdkConfig = initialize({ env: "devnet" });

  // Initialize the wallet
  const wallet = new Wallet(loadKeypair(PRIVATE_KEY));
  console.log("wallet:", wallet.publicKey.toBase58());

  const bulkAccountLoader = new BulkAccountLoader(
    connection,
    "confirmed",
    1000
  );

  // Init Drift client
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: "devnet",
    accountSubscription: {
      type: "polling",
      accountLoader: bulkAccountLoader,
    },
  });
  await driftClient.subscribe();

  // Get the wallet balance
  const lamportsBalance = await connection.getBalance(
    driftClient.wallet.publicKey
  );
  console.log(`Wallet Balance: ${lamportsBalance / 1e9} SOL`);

  // Get the user account public key
  const subAccountId = 0;
  const userAccountPublicKey = await getUserAccountPublicKey(
    driftClient,
    subAccountId
  );
  let user;

  // Check if user account exists
  if (userAccountPublicKey) {
    console.log(`User Account Public Key: ${userAccountPublicKey.toBase58()}`);
    user = new User({
      driftClient: driftClient,
      userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
      accountSubscription: {
        type: "polling",
        accountLoader: bulkAccountLoader,
      },
    });
  } else {
    // User account does not exist, initialize it
    const [txSig, userPublicKey] = await driftClient.initializeUserAccount(
      subAccountId
    );
    console.log(
      `User Account Initialized with address: ${userPublicKey.toBase58()}`
    );

    // Deposit 0.5 SOL into the user account
    const marketIndex = 1; // SOL, ex: 1 for SOL, 0 for USDC
    const amount = driftClient.convertToSpotPrecision(marketIndex, 0.5);
    const associatedTokenAccount = await driftClient.getAssociatedTokenAccount(
      marketIndex
    );
    await driftClient.deposit(amount, marketIndex, associatedTokenAccount);

    user = new User({
      driftClient: driftClient,
      userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
      accountSubscription: {
        type: "polling",
        accountLoader: bulkAccountLoader,
      },
    });
  }

  await user.subscribe();

  // const newSolanaAccount = generateDelegateKeypair();
  // await driftClient.updateUserDelegate(newSolanaAccount.publicKey, subAccountId);

  // Initialize the delegate account
  const newSolanaAccount = initDelegateAccount();

  // Create a new Drift client for the delegate account
  const delegateDriftClient = new DriftClient({
    connection,
    wallet: new Wallet(newSolanaAccount),
    env: "devnet",
    accountSubscription: {
      type: "polling",
      accountLoader: bulkAccountLoader,
    },
    authority: driftClient.wallet.publicKey, // Use the main wallet as authority
    includeDelegates: true, // Include delegate accounts
  });

  await delegateDriftClient.subscribe();

  const tokenInfo = await getTokenInfo("SOL");
  console.log(`Token Info:`, tokenInfo);
  const marketIndex = tokenInfo.marketIndex;

  try {
    // Place order with 0.1 SOL at a price of 165.35 USDC
    const orderParams: OptionalOrderParams = {
      orderType: OrderType.MARKET,
      marketIndex: 0,
      direction: PositionDirection.LONG,
      baseAssetAmount: driftClient.convertToPerpPrecision(0.01),
      price: driftClient.convertToPricePrecision(165.35), // Price in USDC
    };
    const result = await delegateDriftClient.placePerpOrder(orderParams);
    console.log("Order Result:", result);
  } catch (e) {
    if (e instanceof SendTransactionError) {
      console.error("Simulation Logs:", e.logs);
    }
    console.error("Full error:", e);
  }
};

main()
  .then(() => {
    console.log("====>  Successfully!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error:", err);
  });
