import { Progress, Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import { ExclamationCircleOutlined } from "@ant-design/icons";

export enum Status {
  Progress,
  Success,
  Err
}
type LoadingProgressProps = {
  label: string;
  status: Status;
  ErrMsg: string;
};

const LoadingProgress = ({ label, status, ErrMsg }: LoadingProgressProps) => {
  const [percent, setPercent] = useState<number>(0);

  useEffect(() => {
    let interval: NodeJS.Timer | null = null;
    if (status === Status.Progress) {
      interval = setInterval(() => {
        setPercent((prevPercent) => {
          if (prevPercent >= 98) {
            interval && clearInterval(interval);
            return 99;
          }
          return prevPercent + 1;
        });
      }, 50);
    }

    if (interval && (status === Status.Success || status === Status.Err)) {
      clearInterval(interval);
    }

    return () => {
      interval && clearInterval(interval);
    };
  }, [status]);

  return (
    <div className="flex justify-center items-center gap-1">
      <div style={{ textWrap: "nowrap" }}>{label}:</div>
      {(() => {
        if (status === Status.Progress || status === Status.Err) {
          return (
            <Progress
              percent={percent}
              percentPosition={{ align: "center", type: "inner" }}
              size={["100%", 20]}
              strokeColor={{ from: "#3255ff", to: "#6100ff" }}
            />
          );
        }
        if (status === Status.Success) {
          return (
            <Progress
              percent={100}
              percentPosition={{ align: "center", type: "inner" }}
              size={["100%", 20]}
              strokeColor={{ from: "#3255ff", to: "#6100ff" }}
            />
          );
        }
      })()}
      {status === Status.Err && (
        <Tooltip title={ErrMsg}>
          <ExclamationCircleOutlined className="cursor-pointer" style={{ color: "red" }} />
        </Tooltip>
      )}
    </div>
  );
};

export default LoadingProgress;
