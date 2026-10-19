const mongoose = require("mongoose");

// Representa um filtro visual selecionado para a execução.
const videoFilterSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      enum: ["cinzento", "brilho", "contraste", "saturacao"],
    },
    value: {
      type: Number,
      default: null,
    },
  },
  { _id: false }
);

// Representa uma execução de filtros visuais num vídeo.
const videoProcessSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    project_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    msg_id: {
      type: String,
      required: true,
      unique: true,
    },

    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "completed",
        "failed",
        "cancelled",
      ],
      default: "pending",
      required: true,
    },


    //modificado - AB
    filters: {
  type: [videoFilterSchema],
  required: true,
  validate: {
    validator: (filters) => {
      if (!Array.isArray(filters) || filters.length === 0) {
        return false;
      }

      const limites = {
        brilho: [-1.0, 1.0],
        contraste: [0.0, 2.0],
        saturacao: [0.0, 3.0],
      };

      return filters.every((filtro) => {
        if (!filtro || !filtro.name) {
          return false;
        }

        // Tons de cinza não aceita parâmetros.
        if (filtro.name === "cinzento") {
          return filtro.value == null;
        }

        const intervalo = limites[filtro.name];

        if (!intervalo) {
          return false;
        }

        // Nos filtros numéricos, a ausência de valor
        // utiliza o valor predefinido do motor Python.
        if (filtro.value == null) {
          return true;
        }

        const [minimo, maximo] = intervalo;

        return (
          typeof filtro.value === "number" &&
          Number.isFinite(filtro.value) &&
          filtro.value >= minimo &&
          filtro.value <= maximo
        );
      });
    },
    message: "Lista de filtros ou parâmetros inválidos.",
  },
},

    input_video_key: {
      type: String,
      required: true,
    },

    output_video_key: {
      type: String,
      default: null,
    },

    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    error_message: {
      type: String,
      default: null,
    },

    //AB Identificador do worker que reclamou esta execução.
    worker_id: {
        type: String,
        default: null,
    },

    //AB Última comunicação do worker durante o processamento.
    last_heartbeat_at: {
        type: Date,
        default: null,
    },

    //AB Número de reclamações da execução.
    attempt: {
        type: Number,
        default: 0,
        min: 0,
    },

    started_at: {
      type: Date,
      default: null,
    },

    finished_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("videoProcess", videoProcessSchema);