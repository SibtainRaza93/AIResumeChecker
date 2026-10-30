const express = require("express");
const cors = require("cors");
const cookieParse = require("cookie-parser");
const morgan = require("morgan");


const env = require("./src/config/env");
const { connectDB} = require("./src/config/db");
const {notFound, errorHandler} = require("./src/middleware/errorHandler");

const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

//APIS
const healthRouter = require("./src/routes/health");
const authRouter = require("./src/routes/auth.router");

const app = express();

app.set("trust proxy", 1);
app.use(
    cors({
        origin: true, // reflect request origin
        credentials: true,
    })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb"}));
app.use(cookieParse());
if(!env.isProd) app.use(morgan("dev"));


//APIS 
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);

app.use(notFound)
app.use(errorHandler)

async function start() {
    try {
        await connectDB();
        app.listen(env.port, ()=>{
            console.log(`server listening on http;//localhost:${env.port} (${env.nodeEnv})`);
        });
    } catch (error) {
        console.log("Failed to start server:", error.message);;
        process.exit(1);
        
    }
}

process.on("unhandleRejection", (reason) =>{
    console.error("Unhandle rejection", reason);
})

start();

module.exports = app;