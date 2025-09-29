import CloseButton from '@/components/ui/closeButton';
import useRouteLogin from '@/hooks/useRouteLogin';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const GoLoginModal: React.FC<ModalProps> = ({ isOpen, onClose }) => {
  const { routerLogin } = useRouteLogin();
  const toLogin = () => routerLogin(onClose);

  if (!isOpen) return null;

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center'>
      <div
        className='absolute inset-0 bg-gray-900 opacity-20'
        onClick={onClose}
      ></div>
      <div className='relative flex max-h-[600px] w-10/12 flex-col items-center gap-1 rounded-md bg-white px-8 py-12 shadow-lg lg:w-1/3'>
        <CloseButton onClose={onClose} />
        <p className='mb-4 w-full bg-gradient-to-r from-blue-600 to-cyan-500 bg-clip-text text-left text-3xl font-semibold text-transparent'>
          Want to use more features?
        </p>
        <p className='w-full text-left text-base text-gray-600'>
          Use our products with the help of AI technology.
        </p>
        <p className='w-full text-left text-base text-gray-600'>
          You have reached the limit of free credits
        </p>
        <div className='mt-4 flex w-full flex-col justify-center gap-1 rounded-2xl border border-gray-200 bg-white p-1.5'>
          <p className='w-full py-1 text-center text-sm text-gray-600'>
            Sign up to get 3 more credits
          </p>

          <button className='highlight-button !w-full text-lg' onClick={toLogin}>
            Login to continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default GoLoginModal;