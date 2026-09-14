import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import GarmentRecognitionOverlay from './GarmentRecognitionOverlay';

afterEach(cleanup);

test('renders nothing while idle or checking (no premature UI)', () => {
  const { container: idle } = render(<GarmentRecognitionOverlay phase="idle" result={null} onConfirm={jest.fn()} />);
  expect(idle).toBeEmptyDOMElement();
  cleanup();
  const { container: checking } = render(<GarmentRecognitionOverlay phase="checking" result={null} onConfirm={jest.fn()} />);
  expect(checking).toBeEmptyDOMElement();
});

test('confirming: shows the yes/no prompt and calls onConfirm with the right value', () => {
  const onConfirm = jest.fn();
  render(<GarmentRecognitionOverlay phase="confirming" result={{ frame: new Blob() }} onConfirm={onConfirm} />);
  expect(screen.getByText(/add it to your wardrobe/i)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Add it'));
  expect(onConfirm).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByText('No thanks'));
  expect(onConfirm).toHaveBeenCalledWith(false);
});

test('recognized: shows which item it is, with no confirm buttons', () => {
  render(<GarmentRecognitionOverlay phase="recognized"
    result={{ item: { category: 'top', subcategory: 'tshirts', primaryColor: '#123456', thumbnailUrl: '/t.jpg' }, similarity: 0.9 }}
    onConfirm={jest.fn()} />);
  expect(screen.getByText(/that's your tshirts/i)).toBeInTheDocument();
  expect(screen.queryByText('Add it')).not.toBeInTheDocument();
});

test('enrolling: shows an in-progress state', () => {
  render(<GarmentRecognitionOverlay phase="enrolling" result={null} onConfirm={jest.fn()} />);
  expect(screen.getByText(/adding to your wardrobe/i)).toBeInTheDocument();
});

test('added: shows the newly created item', () => {
  render(<GarmentRecognitionOverlay phase="added"
    result={{ item: { category: 'bottom', subcategory: 'jeans', primaryColor: '#000', thumbnailUrl: '/j.jpg' } }}
    onConfirm={jest.fn()} />);
  expect(screen.getByText(/added to your wardrobe/i)).toBeInTheDocument();
  expect(screen.getByAltText('Newly added garment')).toHaveAttribute('src', '/j.jpg');
});
