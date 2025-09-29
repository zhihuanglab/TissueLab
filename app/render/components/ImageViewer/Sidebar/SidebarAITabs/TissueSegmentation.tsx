import React from 'react';
import Image from 'next/image';
import { CForm, CFormLabel } from '@coreui/react';

const TissueSegmentation = () => {
  return (
    <CForm className="p-3 d-flex flex-column" style={{height: '100%'}}>
      <div className="text-center">
        <CFormLabel className="fw-bold mb-3">Tissue Image</CFormLabel>
        <Image 
          src="/images/full_wsi_image.png"
          alt="Tissue Sample"
          width={400}
          height={300}
          style={{
            maxWidth: '100%',
            height: 'auto',
            borderRadius: '8px',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}
        />
      </div>
    </CForm>
  );
};

export default TissueSegmentation;
