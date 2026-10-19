var createError = require("http-errors");
var express = require("express");
var path = require("path");
var cookieParser = require("cookie-parser");
var logger = require("morgan");
const mongoose = require("mongoose");
const videoRoutes = require("./routes/videos");
const { router: projectsRouter, process_msg } = require("./routes/projects");
const { iniciarConsumidorVideo } = require("./utils/video_results");

// Run Docker
const mongoDB = "mongodb://projects_mongoDB:27018/project";

mongoose.connect(mongoDB, { useNewUrlParser: true, useUnifiedTopology: true });

const db = mongoose.connection;

db.on("error", console.error.bind(console, "Error connecting to Mongodb"));
db.once("open", () => {
  console.log("Mongodb connection successful");

  //AB Iniciar o consumidor de vídeos após a ligação ao MongoDB.
  iniciarConsumidorVideo().catch((erro) => {
    console.error(
      "[VIDEO] Não foi possível iniciar o consumidor:",
      erro.message
    );
  });
});

var app = express();

// view engine setup
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "jade");

app.use(logger("dev"));
app.use(express.json());
//AB Operação interna utilizada pelo worker de filtros de vídeo.
app.use("/internal/video", require("./routes/videoClaim"));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

//AB Rotas HTTP exclusivas de vídeo.
app.use("/", videoRoutes);

app.use("/", projectsRouter);

// Start the message processing
process_msg();

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "development" ? err : {};

  // render the error page
  res.status(err.status || 500).jsonp(err);
});

module.exports = app;
