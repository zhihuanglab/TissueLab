<div align="center">

# TissueLab

**A Co-evolving Agentic AI System for Medical Imaging Analysis**

</div>

<div align="center">

[![arXiv](https://img.shields.io/badge/arXiv-2509.20279-b31b1b.svg)](https://arxiv.org/abs/2509.20279)
[![Platform](https://img.shields.io/badge/Platform-www.tissuelab.org-blue.svg)](https://www.tissuelab.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://python.org)

</div>

<br>

<div align="center">
  <img src="app/TissueLab_logo.ico" width="150px" />
</div>

<br>

## 🚀 Platform Access
**Live Demo**: [www.tissuelab.org](https://www.tissuelab.org)

## 📄 Research Paper
**Paper**: [A co-evolving agentic AI system for medical imaging analysis](https://arxiv.org/abs/2509.20279) (arXiv:2509.20279)

## 🌟 Abstract

Agentic AI is rapidly advancing in healthcare and biomedical research. However, in medical image analysis, their performance and adoption remain limited due to the lack of a robust ecosystem, insufficient toolsets, and the absence of real-time interactive expert feedback. Here we present **TissueLab**, a co-evolving agentic AI system that allows researchers to ask direct questions, automatically plan and generate explainable workflows, and conduct real-time analyses where experts can visualize intermediate results and refine them. 

TissueLab integrates tool factories across pathology, radiology, and spatial omics domains. By standardizing inputs, outputs, and capabilities of diverse tools, the system determines when and how to invoke them to address research and clinical questions. Across diverse tasks with clinically meaningful quantifications that inform staging, prognosis, and treatment planning, TissueLab achieves state-of-the-art performance compared with end-to-end vision-language models (VLMs) and other agentic AI systems such as GPT-5. Moreover, TissueLab continuously learns from clinicians, evolving toward improved classifiers and more effective decision strategies. With active learning, it delivers accurate results in unseen disease contexts within minutes, without requiring massive datasets or prolonged retraining. Released as a sustainable open-source ecosystem, TissueLab aims to accelerate computational research and translational adoption in medical imaging while establishing a foundation for the next generation of medical AI.

### Key Features
- **🤖 Direct Question-Answering**: Ask natural language questions about medical images
- **⚡ Automatic Workflow Generation**: AI-powered planning and execution of analysis workflows  
- **👁️ Real-time Interactive Analysis**: Visualize intermediate results and refine analyses
- **🔬 Cross-domain Integration**: Pathology, radiology, and spatial omics tools
- **🧠 Continuous Learning**: Evolves with clinician feedback through active learning
- **🌐 Open Source**: Sustainable ecosystem for computational research and clinical adoption
- **🏥 Hospital-Ready**: Operates within hospital firewalls while providing cutting-edge AI capabilities

## Pre-requisite - If this is your first time installing TissueLab (otherwise directly jump to **Initialize TissueLab**)

Initialize Git LFS.
If this is your first time using `git-lfs`, please follow this tutorial: https://docs.github.com/en/repositories/working-with-files/managing-large-files/installing-git-large-file-storage.


Step 1. Install electron

Install node.js from ```https://nodejs.org/en/download/``` (use version `v20.16.0`).

On Mac OS or Ubuntu:

1. To download and install [electron](https://electron.atom.io) ( OS X or Linux ) you have to download it from [npm-electron](https://www.npmjs.com/package/electron) using :

   ```
   npm install electron --save-dev
   ```

   ```
   npm install -g electron
   ```

   ( if you don't have npm installed use this [link](https://nodejs.org/en/download/) to download it. )

2. Clone this repository:
   ```
   git clone https://github.com/zhihuanglab/TissueLab.git
   ```

## 🚀 Quick Start

### Prerequisites

- **Node.js** v20.16.0+ ([Download](https://nodejs.org/en/download/))
- **Python** 3.11+ with conda
- **Git LFS** for large file storage
- **NVIDIA GPU** (recommended for AI acceleration)

### 1. Clone and Setup

```bash
# Clone the repository
git clone https://github.com/zhihuanglab/TissueLab.git
cd TissueLab

# Initialize Git LFS
git lfs fetch
git lfs pull
```

### 2. Install Dependencies

```bash
# Install Electron dependencies
cd app
    npm install

# Install Frontend dependencies
cd render
    npm install
    npm run build
    cd ..

# Install Backend dependencies
cd service
conda create -n tissuelab-ai python=3.11
conda activate tissuelab-ai
pip install -r requirements-windows.txt  # Choose your platform
cd ..
```

### 3. Configure Environment (Optional)

**By default**, TissueLab connects to our ecosystem services. No additional configuration needed.

**To build your own agent**, configure the frontend:

```bash
# Navigate to frontend directory
cd app/render

# Create environment file
touch .env.local

# Edit configuration for your own agent:
PUBLIC_CTRL_SERVICE_HOST=your-agent-host
PUBLIC_CTRL_SERVICE_API_ENDPOINT=https://your-agent-endpoint.com
```

**To use your own OpenAI key**, configure the backend:

```bash
# Navigate to backend directory
cd app/service

# Create environment file
touch .env

# Add your OpenAI key:
OPENAI_API_KEY=your-open-ai-key
```

### 4. Launch TissueLab

```bash
# Start the complete application
npm start
```

The application will automatically:
- Start the Electron desktop window
- Launch the Python backend service (port 5001)
- Serve the frontend interface (port 3000)

## 🏗️ Architecture Overview

TissueLab follows a modern three-tier architecture:

### 🖥️ Desktop Layer (Electron)
- **Cross-platform desktop application**
- **Secure file system access**
- **Native OS integration**
- **Hospital firewall compatibility**

### 🎨 Frontend Layer (Next.js + React)
- **Modern React-based UI**
- **Real-time image visualization**
- **Interactive annotation tools**
- **Responsive design for medical workflows**

### 🧠 Backend Layer (Python + FastAPI)
- **AI model inference engine**
- **Medical image processing**
- **RESTful API services**
- **Microservices architecture**


## 📁 Project Structure

```
TissueLab/
├── app/                           # Main application directory
│   ├── electron/                  # Electron main process
│   │   ├── main.js              # Main entry point
│   │   └── preload.js            # Preload script
│   ├── render/                   # Frontend (Next.js)
│   │   ├── components/           # React components
│   │   ├── pages/               # Next.js pages
│   │   ├── hooks/               # Custom hooks
│   │   ├── services/            # API services
│   │   └── store/               # State management
│   └── service/                  # Backend (Python)
│       ├── app/                  # FastAPI application
│       │   ├── api/             # API endpoints
│       │   ├── services/        # Business logic
│       │   ├── websocket/       # WebSocket handlers
│       │   └── core/            # Core configurations
│       ├── main.py              # Backend entry point
│       └── requirements-*.txt   # Platform dependencies
```

## 🖥️ Electron Desktop Application

### Features
- **Cross-platform support**: Windows, macOS, Linux
- **Native file system access**: Secure handling of medical images
- **Auto-update capability**: Seamless application updates
- **System integration**: Native OS features and notifications


## 🎨 Frontend (Next.js + React)

### Key Technologies
- **Next.js 13+** - React framework with App Router
- **TypeScript** - Type-safe development
- **Tailwind CSS** - Utility-first styling
- **OpenSeadragon** - Medical image viewer
- **Zustand** - State management
- **React Query** - Data fetching and caching

### Development Workflow
```bash
# Development mode with hot reload
cd app/render
npm run dev

# Production build
    npm run build

# Type checking
npm run type-check

# Linting
npm run lint
```

### Environment Configuration

TissueLab supports flexible configuration for different deployment scenarios:

#### Default Configuration
**By default**, TissueLab connects to our ecosystem services. No additional configuration needed.

#### Build Your Own Agent (Frontend Configuration)
To use your own agent system, configure the frontend:

```bash
# Create app/render/.env.local with:
PUBLIC_CTRL_SERVICE_HOST=localhost
PUBLIC_CTRL_SERVICE_API_ENDPOINT=http://localhost:5001
```

#### Custom OpenAI Integration
To use your own OpenAI API key:

```bash
# Create app/render/.env.local with:
OPENAI_API_KEY=your-open-ai-key
```

#### Build Your Own Agent
Configure custom agent endpoints:

```bash
# Create app/render/.env.local with:
PUBLIC_CTRL_SERVICE_HOST=your-agent-host
PUBLIC_CTRL_SERVICE_API_ENDPOINT=https://your-agent-endpoint.com
```

### Frontend Structure
```
app/render/
├── components/          # Reusable React components
│   ├── Dashboard/       # Main dashboard components
│   ├── ImageViewer/     # Medical image viewer
│   ├── AgentZoo/        # AI model management
│   └── ui/              # UI components
├── pages/               # Next.js pages (routes)
│   ├── dashboard.tsx    # Main dashboard
│   ├── imageViewer.tsx  # Image analysis interface
│   └── AIModelZoo.tsx   # AI model marketplace
├── hooks/               # Custom React hooks
├── services/            # API service layer
├── store/               # State management
├── utils/               # Utility functions
└── types/               # TypeScript definitions
```


## 🧠 Backend (Python + FastAPI)

### Core Components
- **FastAPI Application**: High-performance async API framework
- **Celery Task Queue**: Distributed background task processing
- **WebSocket Support**: Real-time communication for live updates
- **Microservices Design**: Modular, scalable service architecture
- **AI Model Integration**: Seamless integration with various AI models

### Key Features
- **Real-time Processing**: Live image analysis and feedback
- **Distributed Computing**: Scalable task distribution
- **Model Management**: Dynamic AI model loading and switching
- **Active Learning**: Continuous model improvement
- **Multi-modal Support**: Pathology, radiology, and spatial omics

### Backend Structure
```
app/service/
├── app/                           # Main FastAPI application
│   ├── api/                       # API endpoints
│   │   ├── tasks.py              # Task management endpoints
│   │   ├── agent.py              # AI agent endpoints
│   │   ├── seg.py                # Segmentation endpoints
│   │   ├── load.py               # Data loading endpoints
│   │   ├── h5.py                 # H5 file management
│   │   ├── feedback.py           # User feedback endpoints
│   │   └── active_learning.py   # Active learning endpoints
│   ├── services/                 # Business logic services
│   │   ├── factory/              # AI model factories
│   │   │   ├── nuclei_segmentation.py
│   │   │   ├── tissue_segmentation.py
│   │   │   ├── nuclei_classifier.py
│   │   │   └── wsi_encoder.py
│   │   ├── tasks/                # Task management
│   │   │   ├── task_manager.py
│   │   │   └── task_node.py
│   │   └── prompts/             # AI system prompts
│   ├── websocket/                # WebSocket handlers
│   │   ├── segmentation_consumer.py
│   │   └── thumbnail_consumer.py
│   ├── core/                     # Core configurations
│   ├── middlewares/              # Custom middleware
│   └── utils/                    # Utility functions
├── main.py                       # Application entry point
├── requirements-*.txt            # Platform-specific dependencies
└── storage/                      # Data storage and models
```

### Running the Backend
```bash
# Development mode
cd app/service
conda activate tissuelab-ai
python main.py --dev

# Production mode
python main.py

# With specific port
python main.py --port 5001
```

### API Endpoints
- `/api/tasks` - Task management and status
- `/api/agent` - AI agent interactions
- `/api/seg` - Image segmentation
- `/api/load` - Data loading and processing
- `/api/feedback` - User feedback collection
- `/ws` - WebSocket connections for real-time updates

## 🔧 Integrate Your Own Model

TissueLab supports seamless integration of custom AI models into our co-evolving agentic AI system. You can train your own models, collect data, and contribute to the ecosystem.

### Model Integration Pipeline

To integrate your custom model, create a FastAPI service with the following endpoints:

#### Required API Endpoints

```python
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Dict, Any, Optional
import asyncio

app = FastAPI()

# 1. Model Initialization
@app.post("/init")
async def init_model(config: Dict[str, Any]):
    """
    Initialize your model with configuration
    Returns: Model instance and metadata
    """
    # Your model initialization logic
    pass

# 2. Input Requirements
@app.get("/read")
async def get_input_requirements():
    """
    Define what inputs your model expects
    Returns: Input schema and requirements
    """
    pass

# 3. Model Execution
@app.post("/execute")
async def execute_model(input_data: Dict[str, Any]):
    """
    Run your model on the provided input
    Returns: Model predictions and results
    """
    # Your model inference logic
    pass

# 4. Progress Tracking (Optional)
@app.get("/progress")
async def get_progress():
    """
    Server-Sent Events for progress tracking
    Returns: Real-time progress updates
    """
    # SSE implementation for progress tracking
    pass
```

### Integration Resources

#### 1. **TissueLab Model Zoo**
Reference implementation and examples:
- **GitHub**: [https://github.com/zhihuanglab/Tissuelab-Model-Zoo](https://github.com/zhihuanglab/Tissuelab-Model-Zoo)
- **Purpose**: See how other models are integrated
- **Examples**: Complete model integration examples

#### 2. **TissueLab SDK**
Pre-built image processing utilities:
- **GitHub**: [https://github.com/zhihuanglab/TissueLab-SDK](https://github.com/zhihuanglab/TissueLab-SDK)
- **Purpose**: Reduce development costs with ready-to-use image processing
- **Features**: Image loading, preprocessing, postprocessing utilities

#### Integration Workflow

##### Step 1: Develop Your Model Service
```bash
# Create your FastAPI service
pip install fastapi uvicorn tissuelab-sdk

# Implement the required endpoints
# Reference: https://github.com/zhihuanglab/Tissuelab-Model-Zoo
```

##### Step 2: Integrate with TissueLab Desktop
1. **Open TissueLab Desktop**
2. **Navigate to Community - Factory**
3. **Click "Add Custom Model"**
4. **Choose your own pipeline**
5. **No coding required for integration - one-click integration!**


#### Walking toward clinical intelligence
- **Use TissueLab's annotation tools** for data labeling
- **Leverage active learning** for efficient data collection
- **Export classifier** in standard formats
- **Contribute to the ecosystem** if you want to share this classifier, everyone can build upon yours, further optimize


## 📢 News

- **Sep 24, 2025**. Our paper *"A co-evolving agentic AI system for medical imaging analysis"* has been published on [arXiv:2509.20279](https://arxiv.org/abs/2509.20279).
- **Sep 29, 2025**. TissueLab platform is now live at [www.tissuelab.org](https://www.tissuelab.org).
- **Sep 29, 2025**. Initial release of the **TissueLab** open-source ecosystem.

## 🤝 Contributing

We welcome contributions from the community! Please see our tutorial for details on how to get started.

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 📞 Contact & Support

- **Platform**: [www.tissuelab.org](https://www.tissuelab.org)
- **Paper**: [arXiv:2509.20279](https://arxiv.org/abs/2509.20279)
- **Issues**: [GitHub Issues](https://github.com/zhihuanglab/TissueLab/issues)
- **Discussions**: [GitHub Discussions](https://github.com/zhihuanglab/TissueLab/discussions)

## 🙏 Acknowledgments

We gratefully acknowledge support from our institutions and all contributors. This work represents a collaborative effort to advance medical imaging AI through open-source innovation.

### Institutional Support
- Department of Pathology, University of Pennsylvania
- Department of Electrical and System Engineering, University of Pennsylvania

### Community
- All open-source contributors and the broader medical AI community

### Related Work
This project builds upon and integrates with various open-source medical imaging tools and frameworks. We thank the developers and researchers who have contributed to the broader ecosystem of medical AI tools.

## 📚 Citation

If you use TissueLab in your research, please cite our paper:

```bibtex
@article{li2025co,
  title={A co-evolving agentic AI system for medical imaging analysis},
  author={Li, Songhao and Xu, Jonathan and Bao, Tiancheng and Liu, Yuxuan and Liu, Yuchen and Liu, Yihang and Wang, Lilin and Lei, Wenhui and Wang, Sheng and Xu, Yinuo and Cui, Yan and Yao, Jialu and Koga, Shunsuke and Huang, Zhi},
  journal={arXiv preprint arXiv:2509.20279},
  year={2025}
}
```
