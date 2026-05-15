import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch } from '@/utils/common/apiFetch';
import { useState } from 'react';

const SidebarPreprocess = () => {
  const [progress, setProgress] = useState(0);
  const [model, setModel] = useState('stardist');
  const [magnification, setMagnification] = useState('auto');
  const [manualMagnification, setManualMagnification] = useState('');
  const [numberOfNuclei, setNumberOfNuclei] = useState(null); // State to hold the number of nuclei

  const checkProgress = async () => {
    const progressResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/load/v1/get-progress/`, {
      method: 'GET',
      returnAxiosFormat: true,
    });
    const progressJson = progressResponse.data;

    const progressData = progressJson.data || progressJson;
    setProgress(progressData.progress);

    if (progressData.progress < 100) {
      setTimeout(checkProgress, 1000); // Check again in 1 second
    } else {
      const resultResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/load/v1/get-result/`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      const resultJson = resultResponse.data;

      const resultData = resultJson.data || resultJson;
      setNumberOfNuclei(resultData.number_of_nuclei);
    }
  };

  const handleRunButtonClick = async () => {
    const params = {
      model: model,
      magnification: magnification === 'manual' ? manualMagnification : magnification,
    };

    const url = `${AI_SERVICE_API_ENDPOINT}/load/v1/run-preprocess/?${new URLSearchParams(params).toString()}`;
    const response = await apiFetch(url, {
      method: 'POST',
      returnAxiosFormat: true,
    });

    const responseJson = response.data;
    const responseData = responseJson.data || responseJson;
    
    if (response.status === 200) {
      // Start polling for progress
      checkProgress();
    } else {
      console.error('Failed to run preprocess');
    }
  };

  return (
    <div className="bg-card rounded-md shadow-md w-[300px] self-start p-[15px] text-sm">
      <div className="bg-muted border-b border-border font-bold text-lg m-0 py-2">
        <h4 className="m-0">Preprocess</h4>
      </div>
      <div className="p-4">
        <p className="mb-4">
          To better enable some AI functions, such as real-time nuclei classification, we need to preprocess the image data.
        </p>
        <h5 className="mb-[15px] font-semibold">Nuclei Segmentation and Basic Statistics</h5>

        <div className="mb-[10px]">
          <strong className="block mb-2">Model:</strong>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="mb-[10px]" aria-label="Select Model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stardist">Stardist</SelectItem>
              <SelectItem value="cellvit">CellVit</SelectItem>
              <SelectItem value="fast-color-threshold">Fast Color Threshold</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="mb-[10px]">
          <strong className="block mb-2">Magnification:</strong>
          <Select value={magnification} onValueChange={setMagnification}>
            <SelectTrigger aria-label="Select Magnification">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {magnification === 'manual' && (
          <div className="mb-5">
            <Input
              type="number"
              placeholder="Enter Magnification Value"
              value={manualMagnification}
              onChange={(e) => setManualMagnification(e.target.value)}
            />
          </div>
        )}

        <div className="mb-5">
          <Button onClick={handleRunButtonClick} className="bg-primary text-primary-foreground hover:bg-primary/90">
            Run
          </Button>
        </div>

        <div className="mb-[15px]">
          <Progress value={progress} />
          <div className="text-xs text-muted-foreground mt-1">{progress}% Complete</div>
        </div>

        {progress > 0 && (
          <div className="text-xs text-muted-foreground mb-4">
            Processing nuclei segmentation and calculating basic statistics. Please wait...
          </div>
        )}

        {numberOfNuclei !== null && (
          <div className="mt-[15px] text-sm text-success">
            Number of Nuclei Detected: {numberOfNuclei}
          </div>
        )}
      </div>
    </div>
  );
};

export default SidebarPreprocess;
